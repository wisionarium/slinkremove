/* ==========================================================================
   SlinkRemove - Javascript Application Logic
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const selectBtn = document.getElementById('select-btn');
    
    const uploadSection = document.getElementById('upload-section');
    const loadingSection = document.getElementById('loading-section');
    const resultSection = document.getElementById('result-section');
    const firstRunAlert = document.getElementById('first-run-alert');
    
    // View tabs & Single/Slider wrappers
    const tabBtns = document.querySelectorAll('.tab-btn');
    const sliderContainer = document.getElementById('slider-container');
    const resizeWrapper = document.getElementById('resize-wrapper');
    const sliderHandle = document.getElementById('slider-handle');
    const viewOriginal = document.getElementById('view-original');
    const viewRemoved = document.getElementById('view-removed');
    
    // Image tags
    const imgOriginal = document.getElementById('img-original');
    const imgResult = document.getElementById('img-result');
    const imgOriginalSingle = document.getElementById('img-original-single');
    const imgResultSingle = document.getElementById('img-result-single');
    const imgScanPreview = document.getElementById('img-scan-preview');
    
    // Footer buttons
    const restartBtn = document.getElementById('restart-btn');
    const downloadBtn = document.getElementById('download-btn');
    const photoroomKeyInput = document.getElementById('photoroom-key');
    
    // Load saved API key if exists
    if (localStorage.getItem('photoroom_api_key')) {
        photoroomKeyInput.value = localStorage.getItem('photoroom_api_key');
    }
    photoroomKeyInput.addEventListener('input', () => {
        localStorage.setItem('photoroom_api_key', photoroomKeyInput.value.trim());
    });
    
    // State variables
    let originalObjectUrl = null;
    let resultBlobUrl = null;
    let isResizing = false;
    let isFirstRemoval = true; // Tracks if it's the first execution in the session to show model tip


    // --- 1. Drag & Drop + Click Handler ---
    
    // Trigger file chooser
    selectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    dropzone.addEventListener('click', () => {
        fileInput.click();
    });

    // Drag events
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        }, false);
    });

    // Handle dropped file
    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    // Handle selected file from input
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // --- 2. File Processing ---

    function handleFile(file) {
        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Por favor, selecione apenas arquivos de imagem.');
            return;
        }

        // Validate file size (16MB limit)
        if (file.size > 16 * 1024 * 1024) {
            alert('A imagem é muito grande. O limite máximo é de 16 MB.');
            return;
        }

        // Show loading note about downloading model on first execution
        if (isFirstRemoval) {
            firstRunAlert.style.display = 'flex';
        } else {
            firstRunAlert.style.display = 'none';
        }

        // Swap to loading section
        switchSection(loadingSection);

        // Revoke old object URLs if exist to prevent memory leaks
        cleanUrls();

        // Create temporary URL for original image
        originalObjectUrl = URL.createObjectURL(file);
        
        // Load original images immediately into DOM
        imgOriginal.src = originalObjectUrl;
        imgOriginalSingle.src = originalObjectUrl;
        imgScanPreview.src = originalObjectUrl;

        // Build FormData
        const formData = new FormData();
        formData.append('image', file);
        formData.append('photoroom_key', photoroomKeyInput.value.trim());

        // Start upload
        uploadAndProcess(formData);
    }

    function uploadAndProcess(formData) {
        fetch('/remove-bg', {
            method: 'POST',
            body: formData
        })
        .then(async response => {
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Erro desconhecido no servidor.');
            }
            return response.blob();
        })
        .then(blob => {
            // Once we get a successful result, it means the model is initialized. We can hide the first-run warning next time.
            isFirstRemoval = false;

            // Generate URL for result image
            resultBlobUrl = URL.createObjectURL(blob);
            
            // Set image sources
            imgResult.src = resultBlobUrl;
            imgResultSingle.src = resultBlobUrl;

            // Configure Download link
            downloadBtn.href = resultBlobUrl;
            
            // Wait for original image to load to align dimensions
            if (imgOriginal.complete) {
                alignResultImage();
                switchSection(resultSection);
            } else {
                imgOriginal.onload = () => {
                    alignResultImage();
                    switchSection(resultSection);
                };
            }
        })
        .catch(err => {
            console.error(err);
            alert(`Ocorreu um erro: ${err.message}`);
            switchSection(uploadSection);
            fileInput.value = '';
        });
    }

    // Aligns the processed image overlay exactly over the original image inside the comparison slider
    function alignResultImage() {
        // Read dimensions of the rendered original image
        const rect = imgOriginal.getBoundingClientRect();
        
        // Match exact size of result image to the original
        imgResult.style.width = `${rect.width}px`;
        imgResult.style.height = `${rect.height}px`;
        
        // Position result image in exact alignment
        imgResult.style.left = `${imgOriginal.offsetLeft}px`;
        imgResult.style.top = `${imgOriginal.offsetTop}px`;
        imgResult.style.transform = 'none';

        // Reset slider to 50%
        setSliderPosition(50);
    }

    // Recalculate dimensions on window resize to keep images aligned
    window.addEventListener('resize', () => {
        if (resultSection.classList.contains('active')) {
            alignResultImage();
        }
    });

    // Helper to change current visible page card section
    function switchSection(section) {
        [uploadSection, loadingSection, resultSection].forEach(sec => {
            sec.classList.remove('active');
        });
        section.classList.add('active');
    }

    function cleanUrls() {
        if (originalObjectUrl) {
            URL.revokeObjectURL(originalObjectUrl);
            originalObjectUrl = null;
        }
        if (resultBlobUrl) {
            URL.revokeObjectURL(resultBlobUrl);
            resultBlobUrl = null;
        }
    }

    // --- 3. Comparison Slider Logic ---

    // Set Slider overlay position (percentage 0 to 100)
    function setSliderPosition(percentage) {
        percentage = Math.max(0, Math.min(100, percentage));
        resizeWrapper.style.width = `${percentage}%`;
        sliderHandle.style.left = `${percentage}%`;
    }

    // Mouse & Touch events for slider dragging
    const onStartResize = (e) => {
        isResizing = true;
        e.preventDefault();
    };

    const onResize = (e) => {
        if (!isResizing) return;

        const containerRect = sliderContainer.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        
        // Calculate relative position percentage
        const relativeX = clientX - containerRect.left;
        const percentage = (relativeX / containerRect.width) * 100;
        
        setSliderPosition(percentage);
    };

    const onStopResize = () => {
        isResizing = false;
    };

    // Attach event listeners for slider
    sliderHandle.addEventListener('pointerdown', onStartResize);
    window.addEventListener('pointermove', onResize);
    window.addEventListener('pointerup', onStopResize);

    // Also support clicking anywhere on the container to move the slider
    sliderContainer.addEventListener('click', (e) => {
        if (e.target === sliderHandle || sliderHandle.contains(e.target)) return;
        const containerRect = sliderContainer.getBoundingClientRect();
        const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;
        setSliderPosition(percentage);
    });

    // --- 4. Tab switching (Compare / Original / Result) ---

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Toggle active state
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const viewMode = btn.getAttribute('data-view');
            
            // Hide all workspaces
            sliderContainer.classList.add('hidden');
            viewOriginal.classList.add('hidden');
            viewRemoved.classList.add('hidden');

            // Show selected view
            if (viewMode === 'compare') {
                sliderContainer.classList.remove('hidden');
                // Re-align image when tab opens to ensure correct styling
                alignResultImage();
            } else if (viewMode === 'original') {
                viewOriginal.classList.remove('hidden');
            } else if (viewMode === 'removed') {
                viewRemoved.classList.remove('hidden');
            }
        });
    });

    // --- 5. Restart ---
    
    restartBtn.addEventListener('click', () => {
        cleanUrls();
        fileInput.value = '';
        imgScanPreview.src = '';
        
        // Reset tabs to compare mode
        tabBtns.forEach(b => b.classList.remove('active'));
        tabBtns[0].classList.add('active');
        
        sliderContainer.classList.remove('hidden');
        viewOriginal.classList.add('hidden');
        viewRemoved.classList.add('hidden');
        
        switchSection(uploadSection);
    });
});
