document.addEventListener('DOMContentLoaded', () => {
    // DOM 元素
    const homeLink = document.getElementById('homeLink');
    const itemGrid = document.getElementById('itemGrid');
    const breadcrumb = document.getElementById('breadcrumb');
    const actionBar = document.getElementById('actionBar');
    const selectionCountSpan = document.getElementById('selectionCount');
    const createFolderBtn = document.getElementById('createFolderBtn');
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    const multiSelectBtn = document.getElementById('multiSelectBtn');
    const previewBtn = document.getElementById('previewBtn');
    const shareBtn = document.getElementById('shareBtn');
    const renameBtn = document.getElementById('renameBtn');
    const moveBtn = document.getElementById('moveBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const textEditBtn = document.getElementById('textEditBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closeModal = document.querySelector('.close-button');
    const moveModal = document.getElementById('moveModal');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    const conflictModal = document.getElementById('conflictModal');
    const conflictFileName = document.getElementById('conflictFileName');
    const conflictOptions = document.getElementById('conflictOptions');
    const folderConflictModal = document.getElementById('folderConflictModal');
    const folderConflictName = document.getElementById('folderConflictName');
    const folderConflictOptions = document.getElementById('folderConflictOptions');
    const shareModal = document.getElementById('shareModal');
    const uploadModal = document.getElementById('uploadModal');
    const showUploadModalBtn = document.getElementById('showUploadModalBtn');
    const closeUploadModalBtn = document.getElementById('closeUploadModalBtn');
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const fileListContainer = document.getElementById('file-selection-list');
    const folderSelect = document.getElementById('folderSelect');
    const uploadNotificationArea = document.getElementById('uploadNotificationArea');
    const dropZone = document.getElementById('dropZone');
    const dragUploadProgressArea = document.getElementById('dragUploadProgressArea');
    const dragUploadProgressBar = document.getElementById('dragUploadProgressBar');
    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const itemListView = document.getElementById('itemListView');
    const itemListBody = document.getElementById('itemListBody');
    const collapseBtn = document.getElementById('collapseBtn');

    // 状态
    let isMultiSelectMode = false;
    let currentFolderId = 1;
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map();
    let moveTargetFolderId = null;
    let isSearchMode = false;
    const MAX_TELEGRAM_SIZE = 50 * 1024 * 1024; // This constant is now less relevant but kept for potential future use
    let foldersLoaded = false;
    let currentView = 'grid';
    let isRootView = false;

    const formatBytes = (bytes, decimals = 2) => {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    };

    function showNotification(message, type = 'info', container = null) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;

        if (container) {
            notification.classList.add('local');
            container.innerHTML = '';
            container.appendChild(notification);
        } else {
            notification.classList.add('global');
            const existingNotif = document.querySelector('.notification.global');
            if (existingNotif) existingNotif.remove();
            document.body.appendChild(notification);
            setTimeout(() => {
                if (notification.parentElement) notification.parentElement.removeChild(notification);
            }, 5000);
        }
    }
    
    const performUpload = async (formData, isDrag = false) => {
        const progressBar = isDrag ? dragUploadProgressBar : document.getElementById('progressBar');
        const progressArea = isDrag ? dragUploadProgressArea : document.getElementById('progressArea');
        const submitBtn = isDrag ? null : uploadSubmitBtn;
        const notificationContainer = isDrag ? null : uploadNotificationArea;
    
        progressArea.style.display = 'block';
        progressBar.style.width = '0%';
        progressBar.textContent = '0%';
        if (submitBtn) submitBtn.disabled = true;
    
        try {
            const res = await axios.post('/upload', formData, {
                onUploadProgress: p => {
                    const percent = Math.round((p.loaded * 100) / p.total);
                    progressBar.style.width = percent + '%';
                    progressBar.textContent = percent + '%';
                }
            });
            if (res.data.success) {
                if (!isDrag) {
                    uploadModal.style.display = 'none';
                }
                showNotification('上传成功！', 'success');
                fileInput.value = '';
                folderInput.value = '';
                loadFolderContents(currentFolderId);
            } else {
                showNotification(`上传失败: ${res.data.message}`, 'error', notificationContainer);
            }
        } catch (error) {
            showNotification('上传失败: ' + (error.response?.data?.message || '服务器错误'), 'error', notificationContainer);
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            setTimeout(() => { progressArea.style.display = 'none'; }, 2000);
        }
    };
    
    const uploadFiles = async (files, targetFolderId, isDrag = false) => {
        if (files.length === 0) {
            showNotification('请选择文件。', 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }
    
        const fileObjects = Array.from(files).filter(f => f.name);
        const filesToCheck = fileObjects.map(f => ({
            relativePath: f.webkitRelativePath || f.name
        }));

        let existenceData = [];
        try {
            const res = await axios.post('/api/check-existence', { files: filesToCheck, folderId: targetFolderId });
            existenceData = res.data.files;
        } catch (error) {
            showNotification(error.response?.data?.message || '检查文件是否存在时出错。', 'error', !isDrag ? null : uploadNotificationArea);
            return;
        }
    
        let filesToUpload = [];
        let pathsToOverwrite = [];
        const conflicts = [];
        const nonConflicts = [];
    
        for (const file of fileObjects) {
            const relativePath = file.webkitRelativePath || file.name;
            const existing = existenceData.find(f => f.relativePath === relativePath && f.exists);
            if (existing) {
                conflicts.push(file);
            } else {
                nonConflicts.push(file);
            }
        }
        
        filesToUpload.push(...nonConflicts);
    
        if (conflicts.length > 0) {
            const conflictNames = conflicts.map(f => f.webkitRelativePath || f.name);
            const conflictResult = await handleConflict(conflictNames, '上传');
            if (conflictResult.action === 'abort') {
                 if (filesToUpload.length === 0) {
                    showNotification('上传操作已取消。', 'info', !isDrag ? uploadNotificationArea : null);
                    return;
                }
            } else {
                pathsToOverwrite = conflictResult.overwriteList;
                const filesToMaybeUpload = conflicts.filter(f => pathsToOverwrite.includes(f.webkitRelativePath || f.name));
                filesToUpload.push(...filesToMaybeUpload);
            }
        }
    
        if (filesToUpload.length === 0) {
            showNotification('没有文件被上传。', 'success', !isDrag ? uploadNotificationArea : null);
            return;
        }
    
        const formData = new FormData();
        filesToUpload.forEach(file => {
            formData.append('files', file);
            formData.append('relativePaths', file.webkitRelativePath || file.name);
        });
        formData.append('folderId', targetFolderId);
        formData.append('overwritePaths', JSON.stringify(pathsToOverwrite));
    
        const captionInput = document.getElementById('uploadCaption');
        if (captionInput && captionInput.value && !isDrag) {
            formData.append('caption', captionInput.value);
        }
        
        await performUpload(formData, isDrag);
    };

    const loadFolderContents = async (folderId) => {
        try {
            isSearchMode = false;
            if (searchInput) searchInput.value = '';
            currentFolderId = folderId;
            const res = await axios.get(`/api/folder/${folderId}`);
            isRootView = res.data.path.length === 1 && res.data.path[0].id === folderId;
            currentFolderContents = res.data.contents;
            // 清理已不存在的选择项
            const currentIds = new Set([...res.data.contents.folders.map(f => String(f.id)), ...res.data.contents.files.map(f => String(f.id))]);
            selectedItems.forEach((_, key) => {
                if (!currentIds.has(key)) {
                    selectedItems.delete(key);
                }
            });
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateActionBar();
        } catch (error) {
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
            }
            itemGrid.innerHTML = '<p>加载内容失败。</p>';
            itemListBody.innerHTML = '<p>加载内容失败。</p>';
        }
    };
    const executeSearch = async (query) => {
        try {
            isSearchMode = true;
            const res = await axios.get(`/api/search?q=${encodeURIComponent(query)}`);
            currentFolderContents = res.data.contents;
            selectedItems.clear();
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateActionBar();
        } catch (error) {
            itemGrid.innerHTML = '<p>搜寻失败。</p>';
            itemListBody.innerHTML = '<p>搜寻失败。</p>';
        }
    };
    const renderBreadcrumb = (path) => {
        breadcrumb.innerHTML = '';
        if(!path || path.length === 0) return;
        path.forEach((p, index) => {
            if (index > 0) breadcrumb.innerHTML += '<span class="separator">/</span>';
            if (p.id === null) {
                breadcrumb.innerHTML += `<span>${p.name}</span>`;
                return;
            }
            const link = document.createElement(index === path.length - 1 && !isSearchMode ? 'span' : 'a');
            link.textContent = p.name === '/' ? '根目录' : p.name;
            if (link.tagName === 'A') {
                link.href = '#';
                link.dataset.folderId = p.id;
            }
            breadcrumb.appendChild(link);
        });
    };
    
    const renderItems = (folders, files) => {
        const parentGrid = itemGrid;
        const parentList = itemListBody;

        parentGrid.innerHTML = '';
        parentList.innerHTML = '';

        const allItems = [...folders, ...files];
        
        if (allItems.length === 0) {
            if (currentView === 'grid') parentGrid.innerHTML = isSearchMode ? '<p>找不到符合条件的文件。</p>' : (isRootView ? '<p>请先在管理后台新增 WebDAV 挂载点。</p>' : '<p>这个资料夹是空的。</p>');
            else parentList.innerHTML = isSearchMode ? '<div class="list-item"><p>找不到符合条件的文件。</p></div>' : (isRootView ? '<div class="list-item"><p>请先在管理后台新增 WebDAV 挂载点。</p></div>' : '<div class="list-item"><p>这个资料夹是空的。</p></div>');
            return;
        }

        allItems.forEach(item => {
            if (currentView === 'grid') {
                parentGrid.appendChild(createItemCard(item));
            } else {
                parentList.appendChild(createListItem(item));
            }
        });
    };

    const createItemCard = (item) => {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.dataset.id = item.id;
        card.dataset.type = item.type;
        card.dataset.name = item.name === '/' ? '根目录' : item.name;

        let iconHtml = '';
        if (item.type === 'file') {
            const fullFile = currentFolderContents.files.find(f => f.id === item.id) || item;
            if (fullFile.mimetype && fullFile.mimetype.startsWith('image/')) {
                 iconHtml = `<img src="/download/proxy/${item.id}" alt="图片" loading="lazy">`;
            } else if (fullFile.mimetype && fullFile.mimetype.startsWith('video/')) {
                iconHtml = `<video src="/download/proxy/${item.id}#t=0.1" preload="metadata" muted></video>`;
            } else {
                 iconHtml = `<i class="fas ${getFileIconClass(item.mimetype)}"></i>`;
            }
        } else { // folder
            iconHtml = `<i class="fas fa-folder"${item.mount_id ? ' style="color:#17a2b8;"' : ''}></i>`;
        }

        card.innerHTML = `<div class="item-icon">${iconHtml}</div><div class="item-info"><h5 title="${item.name}">${item.name === '/' ? '根目录' : item.name}</h5></div>`;
        if (selectedItems.has(String(item.id))) card.classList.add('selected');
        return card;
    };

    const createListItem = (item) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item';
        itemDiv.dataset.id = item.id;
        itemDiv.dataset.type = item.type;
        itemDiv.dataset.name = item.name === '/' ? '根目录' : item.name;

        const icon = item.type === 'folder' ? 'fa-folder' : getFileIconClass(item.mimetype);
        const name = item.name === '/' ? '根目录' : item.name;
        const size = item.type === 'file' && item.size ? formatBytes(item.size) : '—';
        const date = item.date ? new Date(item.date).toLocaleDateString() : '—';

        itemDiv.innerHTML = `
            <div class="list-icon"><i class="fas ${icon}"${item.mount_id ? ' style="color:#17a2b8;"' : ''}></i></div>
            <div class="list-name" title="${name}">${name}</div>
            <div class="list-size">${size}</div>
            <div class="list-date">${date}</div>
        `;

        if (selectedItems.has(String(item.id))) {
            itemDiv.classList.add('selected');
        }

        return itemDiv;
    };
    
    const updateActionBar = () => {
        if (!actionBar) return;
        const count = selectedItems.size;
        selectionCountSpan.textContent = `已选择 ${count} 个项目`;

        const isSingleItem = count === 1;
        const isSingleFile = isSingleItem && selectedItems.values().next().value.type === 'file';
        const isSingleTextFile = isSingleFile && selectedItems.values().next().value.name.endsWith('.txt');
        const isSingleFolder = isSingleItem && selectedItems.values().next().value.type === 'folder';

        if (createFolderBtn) createFolderBtn.disabled = isRootView;
        if (showUploadModalBtn) showUploadModalBtn.disabled = isRootView;

        if (textEditBtn) {
            textEditBtn.disabled = isRootView || !(count === 0 || isSingleTextFile);
            textEditBtn.innerHTML = count === 0 ? '<i class="fas fa-file-alt"></i>' : '<i class="fas fa-edit"></i>';
            textEditBtn.title = count === 0 ? '新建文字档' : '编辑文字档';
        }

        if (downloadBtn) downloadBtn.disabled = count === 0 || (isSingleFolder && isRootView);
        if (previewBtn) previewBtn.disabled = !isSingleFile;
        if (shareBtn) shareBtn.disabled = !isSingleItem;
        if (renameBtn) renameBtn.disabled = !isSingleItem || (isSingleFolder && isRootView);
        if (moveBtn) moveBtn.disabled = count === 0 || isSearchMode || isRootView;
        if (deleteBtn) deleteBtn.disabled = count === 0 || (isSingleFolder && isRootView);
        
        actionBar.classList.add('visible');

        if (!isMultiSelectMode && multiSelectBtn) {
            multiSelectBtn.classList.remove('active');
        }
    };

    const rerenderSelection = () => {
        document.querySelectorAll('.item-card, .list-item').forEach(el => {
            el.classList.toggle('selected', selectedItems.has(el.dataset.id));
        });
    };

    const switchView = (view) => {
        if (view === 'grid') {
            itemGrid.style.display = 'grid';
            itemListView.style.display = 'none';
            viewSwitchBtn.innerHTML = '<i class="fas fa-list"></i>';
            currentView = 'grid';
        } else {
            itemGrid.style.display = 'none';
            itemListView.style.display = 'block';
            viewSwitchBtn.innerHTML = '<i class="fas fa-th"></i>';
            currentView = 'list';
        }
        renderItems(currentFolderContents.folders, currentFolderContents.files);
    };

    const checkScreenWidthAndCollapse = () => {
        if (window.innerWidth <= 768) {
            if (actionBar && !actionBar.classList.contains('collapsed')) {
                actionBar.classList.add('collapsed');
                const icon = collapseBtn.querySelector('i');
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
                collapseBtn.title = "展开";
            }
        } else {
            if (actionBar && actionBar.classList.contains('collapsed')) {
                 actionBar.classList.remove('collapsed');
                 const icon = collapseBtn.querySelector('i');
                 icon.classList.remove('fa-chevron-up');
                 icon.classList.add('fa-chevron-down');
                 collapseBtn.title = "收起";
            }
        }
    };

    // --- 事件监听 ---
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            window.location.href = '/logout';
        });
    }

    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', async () => {
            const oldPassword = prompt('请输入您的旧密码：');
            if (!oldPassword) return;

            const newPassword = prompt('请输入您的新密码 (至少 4 个字元)：');
            if (!newPassword || newPassword.length < 4) {
                alert('密码长度至少需要 4 个字元。');
                return;
            }

            const confirmPassword = prompt('请再次输入新密码以确认：');
            if (newPassword !== confirmPassword) {
                alert('两次输入的密码不一致！');
                return;
            }

            try {
                const res = await axios.post('/api/user/change-password', { oldPassword, newPassword });
                if (res.data.success) {
                    alert('密码修改成功！');
                }
            } catch (error) {
                alert('密码修改失败：' + (error.response?.data?.message || '服务器错误'));
            }
        });
    }
    
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            actionBar.classList.toggle('collapsed');
            const icon = collapseBtn.querySelector('i');
            if (actionBar.classList.contains('collapsed')) {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
                collapseBtn.title = "展开";
            } else {
                icon.classList.remove('fa-chevron-up');
                icon.classList.add('fa-chevron-down');
                collapseBtn.title = "收起";
            }
        });
    }

    if (uploadForm) {
        uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const filesToProcess = folderInput.files.length > 0 ? folderInput.files : fileInput.files;
            const targetFolderId = folderSelect.value;
            uploadFiles(Array.from(filesToProcess), targetFolderId, false);
        });
    }
    
    if (dropZone) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        dropZone.addEventListener('dragenter', () => !isRootView && dropZone.classList.add('dragover'));
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('dragover');
            if(isRootView) return;
            uploadFiles(Array.from(e.dataTransfer.files), currentFolderId, true);
        });
    }

    if (homeLink) {
        homeLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.location.href = '/';
        });
    }
    const handleItemClick = (e) => {
        const target = e.target.closest('.item-card, .list-item');
        if (!target) return;
        const id = target.dataset.id;
        const type = target.dataset.type;
        const name = target.dataset.name;

        if (isMultiSelectMode) {
            if (selectedItems.has(id)) {
                selectedItems.delete(id);
            } else {
                selectedItems.set(id, { type, name });
            }
        } else {
            const isSelected = selectedItems.has(id);
            selectedItems.clear();
            if (!isSelected) {
                selectedItems.set(id, { type, name });
            }
        }
        rerenderSelection();
        updateActionBar();
    };

    const handleItemDblClick = (e) => {
        const target = e.target.closest('.item-card, .list-item');
        if (target && target.dataset.type === 'folder') {
            const folderId = parseInt(target.dataset.id, 10);
            if (folderId > 0) {
                loadFolderContents(folderId);
            }
        }
    };
    
    if (itemGrid) {
        itemGrid.addEventListener('click', handleItemClick);
        itemGrid.addEventListener('dblclick', handleItemDblClick);
    }
    if (itemListBody) {
        itemListBody.addEventListener('click', handleItemClick);
        itemListBody.addEventListener('dblclick', handleItemDblClick);
    }
    
    if (viewSwitchBtn) {
        viewSwitchBtn.addEventListener('click', () => {
            switchView(currentView === 'grid' ? 'list' : 'grid');
        });
    }

    if (breadcrumb) {
        breadcrumb.addEventListener('click', e => {
            e.preventDefault();
            const link = e.target.closest('a');
            if (link && link.dataset.folderId) {
                loadFolderContents(parseInt(link.dataset.folderId, 10));
            }
        });
    }

    if (createFolderBtn) {
        createFolderBtn.addEventListener('click', async () => {
            if(isRootView) {
                alert("不能在根目录建立资料夹，请先进入一个挂载点。");
                return;
            }
            const name = prompt('请输入新资料夹的名称：');
            if (name && name.trim()) {
                try {
                    await axios.post('/api/folder', { name: name.trim(), parentId: currentFolderId });
                    loadFolderContents(currentFolderId);
                } catch (error) { alert(error.response?.data?.message || '建立失败'); }
            }
        });
    }
    
    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (query) executeSearch(query);
            else if(isSearchMode) loadFolderContents(currentFolderId);
        });
    }

    if (multiSelectBtn) {
        multiSelectBtn.addEventListener('click', () => {
            isMultiSelectMode = !isMultiSelectMode;
            multiSelectBtn.classList.toggle('active', isMultiSelectMode);
            if (!isMultiSelectMode && selectedItems.size > 1) {
                const lastItem = Array.from(selectedItems.entries()).pop();
                selectedItems.clear();
                selectedItems.set(lastItem[0], lastItem[1]);
                rerenderSelection();
                updateActionBar();
            }
        });
    }

    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            isMultiSelectMode = true;
            if (multiSelectBtn) multiSelectBtn.classList.add('active');
            const allVisibleItems = [...currentFolderContents.folders, ...currentFolderContents.files];
            const allVisibleIds = allVisibleItems.map(item => String(item.id));
            const isAllSelected = allVisibleIds.length > 0 && allVisibleIds.every(id => selectedItems.has(id));
            if (isAllSelected) {
                selectedItems.clear();
            } else {
                allVisibleItems.forEach(item => selectedItems.set(String(item.id), { type: item.type, name: item.name }));
            }
            rerenderSelection();
            updateActionBar();
        });
    }

    if (showUploadModalBtn) {
        showUploadModalBtn.addEventListener('click', async () => {
            if(isRootView) {
                alert("不能在根目录直接上传文件，请先进入一个挂载点。");
                return;
            }
            // Logic to show upload modal
            uploadModal.style.display = 'flex';
        });
    }
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (selectedItems.size === 0) return;
            if(isRootView) {
                alert("无法删除根目录下的挂载点，请至管理后台操作。");
                return;
            }
            if (!confirm(`确定要删除这 ${selectedItems.size} 个项目吗？\n注意：删除资料夹将会一并删除其所有内容！`)) return;
            
            const filesToDelete = [], foldersToDelete = [];
            selectedItems.forEach((item, id) => {
                if (item.type === 'file') filesToDelete.push(parseInt(id));
                else foldersToDelete.push(parseInt(id));
            });
            try {
                await axios.post('/delete-multiple', { messageIds: filesToDelete, folderIds: foldersToDelete });
                loadFolderContents(currentFolderId);
            } catch (error) { alert('删除失败，请重试。'); }
        });
    }
    
    // 初始化
    if (itemGrid) {
        const pathParts = window.location.pathname.split('/');
        const lastPart = pathParts.filter(p => p).pop();
        let folderId = parseInt(lastPart, 10);
        if (isNaN(folderId)) {
            axios.get('/').then(res => {
                 // The server redirects to the root folder, so we can parse the new URL
                 const newPath = new URL(res.request.responseURL).pathname;
                 const newId = parseInt(newPath.split('/').pop(), 10);
                 loadFolderContents(newId);
            }).catch(() => {
                loadFolderContents(1); // Fallback
            });
        } else {
            loadFolderContents(folderId);
        }
        
        checkScreenWidthAndCollapse();
        window.addEventListener('resize', checkScreenWidthAndCollapse);
    }
});
