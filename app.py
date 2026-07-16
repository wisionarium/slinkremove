import io
import os
import requests
import numpy as np
import scipy.ndimage as ndimage
from flask import Flask, render_template, request, send_file, jsonify
from rembg import remove, new_session
from PIL import Image
from skimage.measure import label, regionprops
from skimage.feature import peak_local_max
from skimage.segmentation import watershed

app = Flask(__name__)

# Configurações básicas: Limite de 16MB por imagem para proteger o servidor
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

# Tipos de arquivos permitidos
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp'}

# Cache para armazenar as sessões dos modelos e evitar recarregá-las a cada requisição
MODEL_SESSIONS = {}

SUPPORTED_MODELS = {
    'u2net': 'u2net',                    # Padrão geral
    'isnet-general-use': 'isnet-general-use', # Alta precisão
    'u2net_human_seg': 'u2net_human_seg',     # Otimizado para retratos de pessoas
    'silueta': 'silueta'                 # Otimizado para silhuetas e objetos simples
}

def get_model_session(model_name):
    if model_name not in SUPPORTED_MODELS:
        model_name = 'isnet-general-use' # default para alta precisão
        
    real_model_name = SUPPORTED_MODELS[model_name]
    
    if real_model_name not in MODEL_SESSIONS:
        # Inicializa a sessão ONNX para o modelo escolhido
        MODEL_SESSIONS[real_model_name] = new_session(real_model_name)
        
    return MODEL_SESSIONS[real_model_name]

def keep_foreground_components(a_channel, mask_human=None, auto_focus=True):
    # Converte o canal alpha (PIL L) para uma máscara binária NumPy
    mask = np.array(a_channel) > 0
    
    # 1. Correção Inteligente de Cabeça/Cabelo (Head/Hair Correction)
    # Se houver humanos, a parte superior da cabeça e cabelo no mask deve seguir a precisão do mask_human
    # para evitar "bugs" como luminárias ou galhos ao fundo que a IA geral confunde com cabelo.
    if mask_human is not None:
        y_indices, x_indices = np.where(mask_human)
        if len(y_indices) > 1000:  # confirma que há uma pessoa real na imagem
            ymin, ymax = y_indices.min(), y_indices.max()
            xmin, xmax = x_indices.min(), x_indices.max()
            H = ymax - ymin
            
            # Limiar superior para cabeça/cabelo (top 28% da altura da pessoa)
            head_y_limit = ymin + int(H * 0.28)
            
            # Criamos coordenadas y, x
            height, width = mask.shape
            y_grid, x_grid = np.ogrid[:height, :width]
            
            # Máscara correspondente à zona horizontal e vertical da cabeça
            # Estendemos as margens horizontais (5% de H) para segurança dos fios de cabelo
            margin = int(H * 0.05)
            head_zone = (y_grid < head_y_limit) & (x_grid >= max(0, xmin - margin)) & (x_grid <= min(width - 1, xmax + margin))
            
            # Se for a zona da cabeça, removemos do mask tudo o que NÃO for classificado como humano pelo u2net_human_seg
            buggy_pixels = head_zone & mask & (~mask_human)
            mask[buggy_pixels] = False
            
    if not auto_focus:
        a_np = np.array(a_channel)
        a_np[~mask] = 0
        return Image.fromarray(a_np)
        
    # Verifica se há humanos na cena
    has_humans = False
    if mask_human is not None:
        if np.sum(mask_human) > 1000:
            has_humans = True
            
    # 2. Erosão/Dilatação Morfológica Robusta para separar fundos encostados (como o carro prata)
    # Usamos uma estrutura de tamanho 15x15 (raio 7px) para quebrar conexões de sobreposição médias
    struct = np.ones((15, 15))
    eroded_mask = ndimage.binary_erosion(mask, structure=struct)
    
    labeled_eroded, num_eroded_features = label(eroded_mask, return_num=True)
    
    if num_eroded_features == 0:
        # Se a erosão destruiu tudo (imagem muito fina), tenta com um kernel menor (7x7)
        struct = np.ones((7, 7))
        eroded_mask = ndimage.binary_erosion(mask, structure=struct)
        labeled_eroded, num_eroded_features = label(eroded_mask, return_num=True)
        
    if num_eroded_features == 0:
        # Se ainda falhar, retorna a máscara original
        a_np = np.array(a_channel)
        a_np[~mask] = 0
        return Image.fromarray(a_np)
        
    eroded_regions = regionprops(labeled_eroded)
    eroded_regions_sorted = sorted(eroded_regions, key=lambda r: r.area, reverse=True)
    largest_eroded_region = eroded_regions_sorted[0]
    
    keep_eroded_mask = np.zeros_like(mask, dtype=bool)
    height, width = mask.shape
    center_y, center_x = height / 2.0, width / 2.0
    
    for r in eroded_regions:
        keep = False
        
        if has_humans:
            # Mantém componentes com overlap com a máscara humana
            overlap_human = np.sum((labeled_eroded == r.label) & mask_human)
            if overlap_human > 500:
                keep = True
        else:
            # Caso e-commerce/produtos
            if r.label == largest_eroded_region.label:
                keep = True
            else:
                cy, cx = r.centroid
                dist_to_center = np.sqrt((cy - center_y)**2 + (cx - center_x)**2)
                max_dist = np.sqrt(center_y**2 + center_x**2)
                normalized_dist = dist_to_center / max_dist
                size_ratio = r.area / largest_eroded_region.area
                
                if size_ratio > 0.15 and normalized_dist < 0.45:
                    keep = True
                    
        if keep:
            keep_eroded_mask[labeled_eroded == r.label] = True
            
    if np.sum(keep_eroded_mask) == 0:
        keep_eroded_mask[labeled_eroded == largest_eroded_region.label] = True
        
    # Dilata de volta com o mesmo kernel
    dilated_mask = ndimage.binary_dilation(keep_eroded_mask, structure=struct)
    
    # Intersecciona com a máscara original da IA para manter a fidelidade das bordas
    final_mask = dilated_mask & mask
    
    a_np = np.array(a_channel)
    a_np[~final_mask] = 0
    return Image.fromarray(a_np)

def enhance_alpha(image_bytes, threshold, contrast, mask_human=None, auto_focus=True):
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    r, g, b, a = img.split()
    
    # 1. Filtra componentes desconectados em segundo plano (como carros e postes)
    a = keep_foreground_components(a, mask_human, auto_focus)
    
    # 2. Cria a Look-Up Table (LUT) para remover sombras de opacidade baixa
    t_val = int(threshold * 2.55)
    lut_threshold = [0 if i < t_val else i for i in range(256)]
    a = a.point(lut_threshold)
    
    # 3. Cria a Look-Up Table (LUT) para aumentar o contraste da borda
    if contrast > 0:
        factor = 1.0 + (contrast / 15.0) # mapeia 0-100 para fator 1.0 - 7.6
        mid = 127
        # Aumentamos o contraste dos pixels semi-transparentes para nitidez da borda
        lut_contrast = [min(255, max(0, int(mid + (i - mid) * factor))) if i > 0 else 0 for i in range(256)]
        a = a.point(lut_contrast)
        
    img_enhanced = Image.merge("RGBA", (r, g, b, a))
    output = io.BytesIO()
    img_enhanced.save(output, format="PNG")
    return output.getvalue()

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/remove-bg', methods=['POST'])
def remove_background():
    if 'image' not in request.files:
        return jsonify({'error': 'Nenhuma imagem foi enviada.'}), 400
        
    file = request.files['image']
    model_name = 'birefnet-general'
    threshold = 15
    contrast = 5  # Contraste leve de 5 para bordas perfeitamente nítidas e limpas
    alpha_matting = False
    post_process_mask = False
    auto_focus = True
    
    if file.filename == '':
        return jsonify({'error': 'Nenhum arquivo selecionado.'}), 400
        
    if not allowed_file(file.filename):
        return jsonify({'error': 'Formato de arquivo não suportado. Use PNG, JPG, JPEG, WEBP ou BMP.'}), 400

    try:
        # Lendo os bytes da imagem enviada
        input_data = file.read()
        
        # Verificar se chave da API do PhotoRoom foi enviada ou usar a padrão fornecida
        photoroom_key = request.form.get('photoroom_key', '').strip()
        if not photoroom_key:
            photoroom_key = 'sk_pr_jeff_308d7f5d89704e8c21746e59c276e6d1235ce64f'
            
        if photoroom_key:
            try:
                response = requests.post(
                    'https://sdk.photoroom.com/v1/segment',
                    headers={'x-api-key': photoroom_key},
                    files={'image_file': ('image.png', input_data, 'image/png')},
                    timeout=12
                )
                if response.status_code == 200:
                    return send_file(
                        io.BytesIO(response.content),
                        mimetype='image/png',
                        as_attachment=True,
                        download_name='slinkremove-result.png'
                    )
                else:
                    app.logger.warning(f"Erro na API do PhotoRoom ({response.status_code}): {response.text}. Ativando fallback local.")
            except Exception as api_err:
                app.logger.error(f"Falha ao conectar na API do PhotoRoom: {str(api_err)}. Ativando fallback local.")

        # Obter sessão do modelo correspondente (Fallback Local)
        session = get_model_session(model_name)
        
        # Obter sessão do modelo humano para segmentação e identificação de pessoas
        session_human = get_model_session('u2net_human_seg')
        human_mask_bytes = remove(input_data, session=session_human, only_mask=True)
        img_human = Image.open(io.BytesIO(human_mask_bytes)).convert("L")
        mask_human = np.array(img_human) > 127
        
        # Processando a remoção de fundo com o modelo selecionado e parâmetros de máscara
        output_data = remove(
            input_data, 
            session=session,
            alpha_matting=alpha_matting,
            post_process_mask=post_process_mask
        )
        
        # Aplicando realce de bordas, remoção de sombras residuais e isolamento de objeto principal
        final_output = enhance_alpha(output_data, threshold, contrast, mask_human=mask_human, auto_focus=auto_focus)
        
        # Retorna a imagem processada (PNG transparente) como um arquivo binário
        return send_file(
            io.BytesIO(final_output),
            mimetype='image/png',
            as_attachment=True,
            download_name='slinkremove-result.png'
        )
    except Exception as e:
        app.logger.error(f"Erro ao processar imagem: {str(e)}")
        return jsonify({'error': f'Erro ao processar a imagem com o modelo {model_name}: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5001)
