import io
import os
import requests
from flask import Flask, render_template, request, send_file, jsonify
from PIL import Image
import numpy as np

app = Flask(__name__)

# Configurações básicas: Limite de 32MB por imagem para suportar fotos de alta resolução
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024

# Tipos de arquivos permitidos
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff'}

# Cache para armazenar as sessões dos modelos e evitar recarregá-las a cada requisição
MODEL_SESSIONS = {}

SUPPORTED_MODELS = {
    'isnet-general-use': 'isnet-general-use', # Alta precisão Ultra-HD
    'birefnet-general': 'isnet-general-use',  # Fallback alta precisão
    'u2net': 'u2net',                         # Padrão geral
    'u2net_human_seg': 'u2net_human_seg',      # Otimizado para retratos de pessoas
    'silueta': 'silueta'                      # Otimizado para silhuetas
}

def get_model_session(model_name):
    from rembg import new_session
    if model_name not in SUPPORTED_MODELS:
        model_name = 'isnet-general-use' # Default alta precisão
        
    real_model_name = SUPPORTED_MODELS[model_name]
    
    if real_model_name not in MODEL_SESSIONS:
        MODEL_SESSIONS[real_model_name] = new_session(real_model_name)
        
    return MODEL_SESSIONS[real_model_name]

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
    model_name = request.form.get('model', 'isnet-general-use')
    
    if file.filename == '':
        return jsonify({'error': 'Nenhum arquivo selecionado.'}), 400
        
    if not allowed_file(file.filename):
        return jsonify({'error': 'Formato de arquivo não suportado.'}), 400

    try:
        # Lendo os bytes da imagem original enviada
        input_data = file.read()
        
        # 1. Carrega a imagem original preservando 100% das dimensões e pixels de cor
        orig_img = Image.open(io.BytesIO(input_data)).convert("RGBA")
        orig_width, orig_height = orig_img.size
        orig_r, orig_g, orig_b, _ = orig_img.split()
        
        mask_img = None

        # 2. Verificar se chave de API do PhotoRoom foi enviada explicitamente pelo usuário
        photoroom_key = request.form.get('photoroom_key', '').strip()
        if photoroom_key:
            try:
                response = requests.post(
                    'https://sdk.photoroom.com/v1/segment',
                    headers={'x-api-key': photoroom_key},
                    files={'image_file': ('image.png', input_data, 'image/png')},
                    timeout=15
                )
                if response.status_code == 200:
                    pr_img = Image.open(io.BytesIO(response.content)).convert("RGBA")
                    mask_img = pr_img.split()[3] # Extrai o canal alpha do PhotoRoom
                else:
                    app.logger.warning(f"API PhotoRoom respondeu com status {response.status_code}. Usando IA local HD.")
            except Exception as api_err:
                app.logger.error(f"Falha na API PhotoRoom: {str(api_err)}. Usando IA local HD.")

        # 3. Fallback ou processamento padrão via IA Local de Alta Precisão (ISNet-General-Use / Ultra HD)
        if mask_img is None:
            from rembg import remove
            session = get_model_session(model_name)
            
            # Gera a máscara alpha de alta definição
            mask_bytes = remove(input_data, session=session, only_mask=True)
            
            if isinstance(mask_bytes, Image.Image):
                mask_img = mask_bytes.convert("L")
            elif isinstance(mask_bytes, np.ndarray):
                mask_img = Image.fromarray(mask_bytes).convert("L")
            elif isinstance(mask_bytes, (bytes, bytearray)):
                mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
            else:
                mask_img = Image.open(io.BytesIO(bytes(mask_bytes))).convert("L")

        # 4. Redimensiona a máscara com filtro LANCZOS (máxima qualidade de interpolação) se necessário
        if mask_img.size != (orig_width, orig_height):
            mask_img = mask_img.resize((orig_width, orig_height), Image.Resampling.LANCZOS)

        # 5. Combina os canais RGB ORIGINAIS (100% da resolução e cores da foto enviada) com a máscara Alpha
        final_img = Image.merge("RGBA", (orig_r, orig_g, orig_b, mask_img))

        # 6. Salva o PNG final sem compressão com perdas para preservar 100% da nitidez
        output_buffer = io.BytesIO()
        final_img.save(output_buffer, format="PNG", optimize=False)
        output_buffer.seek(0)

        # Nome de arquivo limpo preservando a referência original
        safe_filename = file.filename or 'imagem'
        base_name = os.path.splitext(safe_filename)[0]
        download_filename = f"{base_name}-sem-fundo.png"

        return send_file(
            output_buffer,
            mimetype='image/png',
            as_attachment=True,
            download_name=download_filename
        )
    except Exception as e:
        app.logger.error(f"Erro ao processar imagem: {str(e)}")
        return jsonify({'error': f'Erro ao processar a imagem em alta resolução: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5001)
