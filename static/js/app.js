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
    if (photoroomKeyInput) {
        if (localStorage.getItem('photoroom_api_key')) {
            photoroomKeyInput.value = localStorage.getItem('photoroom_api_key');
        }
        photoroomKeyInput.addEventListener('input', () => {
            localStorage.setItem('photoroom_api_key', photoroomKeyInput.value.trim());
        });
    }
    
    // State variables
    let originalObjectUrl = null;
    let resultBlobUrl = null;
    let isResizing = false;
    let isFirstRemoval = true;


    // --- 1. Drag & Drop + Click Handler ---
    
    if (selectBtn) {
        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.click();
        });
    }

    if (dropzone) {
        dropzone.addEventListener('click', () => {
            fileInput.click();
        });

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

        dropzone.addEventListener('drop', (e) => {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files && files.length > 0) {
                handleFile(files[0]);
            }
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                handleFile(e.target.files[0]);
            }
        });
    }


    // --- 2. File Processing ---

    function handleFile(file) {
        if (!file.type.startsWith('image/')) {
            alert('Por favor, selecione apenas arquivos de imagem.');
            return;
        }

        if (file.size > 16 * 1024 * 1024) {
            alert('A imagem é muito grande. O limite máximo é de 16 MB.');
            return;
        }

        if (firstRunAlert) {
            firstRunAlert.style.display = isFirstRemoval ? 'flex' : 'none';
        }

        switchSection(loadingSection);
        cleanUrls();

        originalObjectUrl = URL.createObjectURL(file);
        
        imgOriginal.src = originalObjectUrl;
        imgOriginalSingle.src = originalObjectUrl;
        if (imgScanPreview) imgScanPreview.src = originalObjectUrl;

        const formData = new FormData();
        formData.append('image', file);
        if (photoroomKeyInput) {
            formData.append('photoroom_key', photoroomKeyInput.value.trim());
        }

        uploadAndProcess(formData);
    }

    function uploadAndProcess(formData) {
        fetch('/remove-bg', {
            method: 'POST',
            body: formData
        })
        .then(async response => {
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || 'Erro desconhecido no servidor.');
            }
            return response.blob();
        })
        .then(blob => {
            isFirstRemoval = false;

            resultBlobUrl = URL.createObjectURL(blob);
            
            imgResult.src = resultBlobUrl;
            imgResultSingle.src = resultBlobUrl;

            if (downloadBtn) {
                downloadBtn.href = resultBlobUrl;
            }
            
            // Switch to result section FIRST so elements are visible and layout dimensions exist!
            switchSection(resultSection);

            // Wait for DOM render & image loads before aligning
            const scheduleAlign = () => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(alignResultImage);
                });
            };

            if (imgOriginal.complete && imgResult.complete) {
                scheduleAlign();
            } else {
                imgOriginal.onload = scheduleAlign;
                imgResult.onload = scheduleAlign;
                // Fallback timeout in case onload fired early
                setTimeout(scheduleAlign, 150);
            }
        })
        .catch(err => {
            console.error(err);
            alert(`Ocorreu um erro: ${err.message}`);
            switchSection(uploadSection);
            if (fileInput) fileInput.value = '';
        });
    }

    // Aligns the processed image overlay exactly over the original image inside the comparison slider
    function alignResultImage() {
        if (!resultSection.classList.contains('active')) return;
        if (sliderContainer.classList.contains('hidden')) return;

        const rect = imgOriginal.getBoundingClientRect();
        
        // If image hasn't rendered yet (0 width/height), retry shortly
        if (rect.width === 0 || rect.height === 0) {
            setTimeout(alignResultImage, 50);
            return;
        }

        // Match exact size of result image to original image rendered dimensions
        imgResult.style.width = `${rect.width}px`;
        imgResult.style.height = `${rect.height}px`;
        
        // Match exact position relative to container
        imgResult.style.left = `${imgOriginal.offsetLeft}px`;
        imgResult.style.top = `${imgOriginal.offsetTop}px`;
        imgResult.style.transform = 'none';

        // Reset slider to 50%
        setSliderPosition(50);
    }

    // Auto-realign on window resize or orientation change
    window.addEventListener('resize', () => {
        if (resultSection.classList.contains('active')) {
            alignResultImage();
        }
    });

    if (window.ResizeObserver && sliderContainer) {
        const ro = new ResizeObserver(() => {
            if (resultSection.classList.contains('active') && !sliderContainer.classList.contains('hidden')) {
                alignResultImage();
            }
        });
        ro.observe(sliderContainer);
    }

    function switchSection(section) {
        [uploadSection, loadingSection, resultSection].forEach(sec => {
            if (sec) sec.classList.remove('active');
        });
        if (section) section.classList.add('active');
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

    function setSliderPosition(percentage) {
        percentage = Math.max(0, Math.min(100, percentage));
        resizeWrapper.style.width = `${percentage}%`;
        sliderHandle.style.left = `${percentage}%`;
    }

    // Drag / Touch / Mouse handlers
    const getClientX = (e) => {
        if (e.touches && e.touches.length > 0) {
            return e.touches[0].clientX;
        }
        if (e.changedTouches && e.changedTouches.length > 0) {
            return e.changedTouches[0].clientX;
        }
        return e.clientX;
    };

    const onStartResize = (e) => {
        isResizing = true;
        e.preventDefault();
    };

    const onResize = (e) => {
        if (!isResizing) return;

        const containerRect = sliderContainer.getBoundingClientRect();
        if (containerRect.width === 0) return;

        const clientX = getClientX(e);
        const relativeX = clientX - containerRect.left;
        const percentage = (relativeX / containerRect.width) * 100;
        
        setSliderPosition(percentage);
    };

    const onStopResize = () => {
        isResizing = false;
    };

    // Pointer & Touch events
    sliderHandle.addEventListener('pointerdown', onStartResize);
    window.addEventListener('pointermove', onResize);
    window.addEventListener('pointerup', onStopResize);
    window.addEventListener('pointercancel', onStopResize);

    // Explicit touch fallbacks for older mobile browsers
    sliderHandle.addEventListener('touchstart', onStartResize, { passive: false });
    window.addEventListener('touchmove', onResize, { passive: false });
    window.addEventListener('touchend', onStopResize);

    // Click on slider container
    sliderContainer.addEventListener('click', (e) => {
        if (e.target === sliderHandle || sliderHandle.contains(e.target)) return;
        const containerRect = sliderContainer.getBoundingClientRect();
        if (containerRect.width === 0) return;
        const clientX = getClientX(e);
        const percentage = ((clientX - containerRect.left) / containerRect.width) * 100;
        setSliderPosition(percentage);
    });


    // --- 4. Tab Switching ---

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const viewMode = btn.getAttribute('data-view');
            
            sliderContainer.classList.add('hidden');
            viewOriginal.classList.add('hidden');
            viewRemoved.classList.add('hidden');

            if (viewMode === 'compare') {
                sliderContainer.classList.remove('hidden');
                requestAnimationFrame(() => {
                    alignResultImage();
                });
            } else if (viewMode === 'original') {
                viewOriginal.classList.remove('hidden');
            } else if (viewMode === 'removed') {
                viewRemoved.classList.remove('hidden');
            }
        });
    });


    // --- 5. Restart Button ---
    
    if (restartBtn) {
        restartBtn.addEventListener('click', () => {
            cleanUrls();
            if (fileInput) fileInput.value = '';
            if (imgScanPreview) imgScanPreview.src = '';
            
            tabBtns.forEach(b => b.classList.remove('active'));
            if (tabBtns[0]) tabBtns[0].classList.add('active');
            
            sliderContainer.classList.remove('hidden');
            viewOriginal.classList.add('hidden');
            viewRemoved.classList.add('hidden');
            
            switchSection(uploadSection);
        });
    }
});
