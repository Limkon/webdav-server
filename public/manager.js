document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const fileList = document.getElementById('file-list');
    const pathContainer = document.getElementById('path-container');
    const loadingIndicator = document.getElementById('loading');
    const uploadBtn = document.getElementById('upload-btn');
    const fileInput = document.getElementById('file-input');
    const newFolderBtn = document.getElementById('new-folder-btn');
    const newFileBtn = document.getElementById('new-file-btn');
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const backBtn = document.getElementById('back-btn');

    // Modals
    const uploadModal = document.getElementById('upload-modal');
    const moveModal = document.getElementById('move-modal');
    const shareModal = document.getElementById('share-modal');
    const editorModal = document.getElementById('text-editor-modal');

    // Modal Controls
    const closeModalBtns = document.querySelectorAll('.close-modal-btn');
    const uploadDropzone = document.getElementById('upload-dropzone');
    const uploadFileInput = document.getElementById('upload-file-input');
    const uploadProgressContainer = document.getElementById('upload-progress-container');
    const folderTreeContainer = document.getElementById('folder-tree');
    const confirmMoveBtn = document.getElementById('confirm-move-btn');
    const confirmShareBtn = document.getElementById('confirm-share-btn');
    const shareLinkContainer = document.getElementById('share-link-container');
    const shareUrlInput = document.getElementById('share-url');
    const copyShareLinkBtn = document.getElementById('copy-share-link-btn');
    
    // Editor elements
    const editorFileName = document.getElementById('editor-file-name');
    const editorTextarea = document.getElementById('editor-textarea');
    const saveTextFileBtn = document.getElementById('save-text-file-btn');
    
    // Globals
    let currentFolderId = null;
    let currentFolderData = null;
    let historyStack = [];
    let editorMode = 'create'; // 'create' or 'edit'
    let editorFileId = null;

    // --- Core Navigation and Data Loading ---

    async function loadFolder(folderId, noPush = false) {
        if (!folderId) {
            console.error("loadFolder called with invalid folderId");
            return;
        }
        
        if (currentFolderId === folderId) return;

        showLoading();
        hideContextMenu();
        try {
            const response = await axios.get(`/api/folder/${folderId}`);
            currentFolderData = response.data;
            if (!noPush && currentFolderId) {
                historyStack.push(currentFolderId);
            }
            currentFolderId = folderId;
            renderFileList(currentFolderData.contents);
            renderBreadcrumbs(currentFolderData.path);
            updateBackButtonState();
        } catch (error) {
            console.error('Failed to load folder:', error);
            alert('无法加载资料夹内容。');
        } finally {
            hideLoading();
        }
    }
    
    async function loadSearchResults(query) {
        showLoading();
        hideContextMenu();
        try {
            const response = await axios.get(`/api/search?q=${query}`);
            currentFolderData = response.data;
            renderFileList(currentFolderData.contents);
            renderBreadcrumbs(currentFolderData.path, true); // isSearch = true
            updateBackButtonState();
        } catch(error) {
            console.error('Search failed:', error);
            alert('搜寻失败。');
        } finally {
            hideLoading();
        }
    }

    // --- Rendering ---
    
    function renderFileList(contents) {
        fileList.innerHTML = '';
        if (!contents || (contents.folders.length === 0 && contents.files.length === 0)) {
            fileList.innerHTML = '<div class="empty-folder-message">这个资料夹是空的</div>';
            return;
        }

        contents.folders.forEach(folder => {
            const item = createFolderElement(folder);
            fileList.appendChild(item);
        });

        contents.files.forEach(file => {
            const item = createFileElement(file);
            fileList.appendChild(item);
        });
    }

    function createFolderElement(folder) {
        const div = document.createElement('div');
        div.className = 'folder-item';
        div.dataset.id = folder.id;
        div.dataset.name = folder.name;
        div.innerHTML = `
            <div class="item-icon">
                <i class="fas fa-folder ${folder.isWebdav ? 'fa-hdd' : ''}"></i>
            </div>
            <div class="item-name">${folder.name}</div>
        `;
        return div;
    }

    function createFileElement(file) {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.dataset.id = file.id;
        div.dataset.name = file.fileName;
        
        const isImage = file.mimetype && file.mimetype.startsWith('image/');
        const thumbnail = isImage ? `/download/proxy/${file.id}` : `/thumbnail/${file.id}`;

        div.innerHTML = `
            <div class="item-icon">
                <img src="${thumbnail}" alt="thumb" loading="lazy" onerror="this.onerror=null;this.src='/img/file-icon.png';">
            </div>
            <div class="item-name">${file.fileName}</div>
            <div class="item-size">${formatBytes(file.size)}</div>
            <div class="item-date">${new Date(file.date).toLocaleDateString()}</div>
        `;
        return div;
    }

    function renderBreadcrumbs(path, isSearch = false) {
        pathContainer.innerHTML = '';
        if (isSearch) {
             const li = document.createElement('li');
             li.textContent = path[0].name;
             pathContainer.appendChild(li);
             return;
        }

        path.forEach((part, index) => {
            const li = document.createElement('li');
            if (index < path.length - 1) {
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = part.name === '/' ? '所有档案' : part.name;
                a.onclick = (e) => {
                    e.preventDefault();
                    // 在导航到新路径前，清除当前路径之后的所有历史纪录
                    const historyIndex = historyStack.indexOf(part.id);
                    if (historyIndex > -1) {
                        historyStack = historyStack.slice(0, historyIndex);
                    }
                    loadFolder(part.id, true);
                };
                li.appendChild(a);
            } else {
                li.textContent = part.name === '/' ? '所有档案' : part.name;
            }
            pathContainer.appendChild(li);
        });
    }

    // --- UI State and Helpers ---
    
    function showLoading() {
        loadingIndicator.style.display = 'flex';
    }

    function hideLoading() {
        loadingIndicator.style.display = 'none';
    }

    function updateBackButtonState() {
        backBtn.disabled = historyStack.length === 0;
    }
    
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0 || !bytes) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
    
    function getSelectedItems() {
        const selectedElements = fileList.querySelectorAll('.selected');
        return Array.from(selectedElements).map(el => ({
            id: el.dataset.id,
            name: el.dataset.name,
            type: el.classList.contains('folder-item') ? 'folder' : 'file'
        }));
    }

    function clearSelection() {
        fileList.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    }

    // --- Event Listeners Setup ---

    function setupEventListeners() {
        // Navigation
        backBtn.addEventListener('click', () => {
            if (historyStack.length > 0) {
                const prevFolderId = historyStack.pop();
                loadFolder(prevFolderId, true);
            }
        });

        // Search
        searchBtn.addEventListener('click', () => {
            const query = searchInput.value.trim();
            if(query) loadSearchResults(query);
        });
        searchInput.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') searchBtn.click();
        });

        // Main action buttons
        uploadBtn.addEventListener('click', () => uploadModal.style.display = 'flex');
        newFolderBtn.addEventListener('click', createNewFolder);
        newFileBtn.addEventListener('click', () => openTextEditor('create'));

        // Close modals
        closeModalBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.modal').style.display = 'none';
            });
        });
        window.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.style.display = 'none';
            }
        });
        
        setupFileEventListeners();
        setupUploadSystem();
        setupMoveSystem();
        setupShareSystem();
        setupEditorSystem();
    }
    
    function setupFileEventListeners() {
        let lastClickedItem = null;

        fileList.addEventListener('click', (e) => {
            hideContextMenu();
            const target = e.target.closest('.file-item, .folder-item');
            if (!target) {
                if (!e.ctrlKey && !e.shiftKey) clearSelection();
                return;
            }
    
            if (e.shiftKey && lastClickedItem) {
                const items = Array.from(fileList.children);
                const start = items.indexOf(lastClickedItem);
                const end = items.indexOf(target);
                const range = items.slice(Math.min(start, end), Math.max(start, end) + 1);
                if (!e.ctrlKey) clearSelection();
                range.forEach(item => item.classList.add('selected'));
            } else if (e.ctrlKey) {
                target.classList.toggle('selected');
            } else {
                clearSelection();
                target.classList.add('selected');
            }
            lastClickedItem = target;
        });

        fileList.addEventListener('dblclick', (e) => {
            const target = e.target.closest('.folder-item');
            if (target) {
                loadFolder(target.dataset.id);
            }
            
            const fileTarget = e.target.closest('.file-item');
            if(fileTarget) {
                 downloadFile(fileTarget.dataset.id, fileTarget.dataset.name);
            }
        });
        
        fileList.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const target = e.target.closest('.file-item, .folder-item');
            if (!target) return;
    
            const id = target.dataset.id;
            const isFolder = target.classList.contains('folder-item');
            const isFile = target.classList.contains('file-item');
            const name = target.querySelector('.item-name').textContent;
    
            // 如果右键的不是已选中的项目，则先清空选中并选中当前项目
            if (!target.classList.contains('selected')) {
                clearSelection();
                target.classList.add('selected');
            }
    
            const selectedItems = getSelectedItems();
            const hasFolders = selectedItems.some(item => item.type === 'folder');
            const hasFiles = selectedItems.some(item => item.type === 'file');
    
            let menuItems = [];
    
            // 单个项目操作
            if (selectedItems.length === 1) {
                const item = selectedItems[0];
                const itemData = isFolder 
                    ? currentFolderData.contents.folders.find(f => String(f.id) === item.id)
                    : currentFolderData.contents.files.find(f => String(f.id) === item.id);
                const isWebdavMount = item.type === 'folder' && itemData?.isWebdav;
                
                if (isFile) {
                    menuItems.push({ label: '下载', icon: 'fas fa-download', action: () => downloadFile(id, name) });
                    if (name.endsWith('.txt')) {
                        menuItems.push({ label: '编辑', icon: 'fas fa-edit', action: () => openTextEditor('edit', id) });
                    }
                }
                menuItems.push({ label: '重新命名', icon: 'fas fa-i-cursor', action: () => renameItem(id, isFolder) });
                // *** 修正：如果是 WebDAV 挂载点，则禁用移动 ***
                menuItems.push({ label: '移动', icon: 'fas fa-truck', action: () => openMoveModal(), disabled: isWebdavMount });
                menuItems.push({ label: '删除', icon: 'fas fa-trash', action: () => deleteSelectedItems() });
                menuItems.push({ separator: true });
                menuItems.push({ label: '分享', icon: 'fas fa-share-alt', action: () => openShareModal(id, isFolder ? 'folder' : 'file') });
                menuItems.push({ label: '取消分享', icon: 'fas fa-ban', action: () => cancelShare(id, isFolder ? 'folder' : 'file') });
    
    
            } 
            // 多个项目操作
            else {
                 // *** 修正：如果选中的项目包含 WebDAV 挂载点，则禁用移动 ***
                const selectionContainsWebdavMount = selectedItems.some(item => {
                    const itemData = currentFolderData.contents.folders.find(f => String(f.id) === item.id);
                    return item.type === 'folder' && itemData?.isWebdav;
                });
                menuItems.push({ label: `移动 ${selectedItems.length} 个项目`, icon: 'fas fa-truck', action: () => openMoveModal(), disabled: selectionContainsWebdavMount });
                menuItems.push({ label: `删除 ${selectedItems.length} 个项目`, icon: 'fas fa-trash', action: () => deleteSelectedItems() });
                if (!hasFolders) { // 只有文件才能打包下载
                    menuItems.push({ separator: true });
                    menuItems.push({ label: `打包下载 ${selectedItems.length} 个文件`, icon: 'fas fa-file-archive', action: () => downloadMultipleFiles() });
                }
            }
    
            showContextMenu(e.clientX, e.clientY, menuItems);
        });

        document.addEventListener('click', () => hideContextMenu());
    }

    // --- Context Menu ---
    function showContextMenu(x, y, items) {
        hideContextMenu();
        const menu = document.createElement('div');
        menu.id = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    
        items.forEach(item => {
            if (item.separator) {
                const separator = document.createElement('div');
                separator.className = 'context-separator';
                menu.appendChild(separator);
            } else {
                const menuItem = document.createElement('div');
                menuItem.className = 'context-menu-item';
                if (item.disabled) {
                    menuItem.classList.add('disabled');
                } else {
                    menuItem.onclick = item.action;
                }
                menuItem.innerHTML = `<i class="${item.icon}"></i> ${item.label}`;
                menu.appendChild(menuItem);
            }
        });
    
        document.body.appendChild(menu);
    }
    
    function hideContextMenu() {
        const menu = document.getElementById('context-menu');
        if (menu) menu.remove();
    }

    // --- File and Folder Actions ---

    async function createNewFolder() {
        const folderName = prompt('请输入新资料夹的名称:');
        if (folderName) {
            try {
                const response = await axios.post('/api/folder', {
                    name: folderName,
                    parentId: currentFolderId
                });
                if (response.data.success) {
                    loadFolder(currentFolderId, true);
                }
            } catch (error) {
                alert(error.response?.data?.message || '建立资料夹失败。');
            }
        }
    }
    
    async function renameItem(id, isFolder) {
        const itemElement = fileList.querySelector(`[data-id='${id}']`);
        const nameElement = itemElement.querySelector('.item-name');
        const currentName = nameElement.textContent;
    
        const newName = prompt('请输入新的名称:', currentName);
        if (newName && newName !== currentName) {
            try {
                await axios.post('/rename', {
                    id: id,
                    newName: newName,
                    type: isFolder ? 'folder' : 'file'
                });
                nameElement.textContent = newName;
                itemElement.dataset.name = newName;
            } catch (error) {
                alert(error.response?.data?.message || '重新命名失败。');
            }
        }
    }

    async function deleteSelectedItems() {
        const selected = getSelectedItems();
        if (selected.length === 0) return;

        const confirmMessage = `确定要删除这 ${selected.length} 个项目吗？此操作无法复原！`;
        if (!confirm(confirmMessage)) return;

        const messageIds = selected.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selected.filter(i => i.type === 'folder').map(i => i.id);

        try {
            await axios.post('/delete-multiple', { messageIds, folderIds });
            loadFolder(currentFolderId, true);
        } catch (error) {
            alert(error.response?.data?.message || '删除失败。');
        }
    }
    
    function downloadFile(fileId, fileName) {
        const url = `/download/proxy/${fileId}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    
    async function downloadMultipleFiles() {
        const selectedFiles = getSelectedItems().filter(item => item.type === 'file');
        if (selectedFiles.length === 0) return;
        
        showLoading();
        try {
            const response = await axios.post('/api/download-archive', {
                messageIds: selectedFiles.map(f => f.id)
            }, {
                responseType: 'blob'
            });

            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            const contentDisposition = response.headers['content-disposition'];
            let filename = 'download.zip';
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename="(.+)"/);
                if (filenameMatch.length === 2)
                filename = filenameMatch[1];
            }
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (error) {
            console.error(error);
            alert('打包下载失败。');
        } finally {
            hideLoading();
        }
    }
    
    // --- Upload System ---

    function setupUploadSystem() {
        uploadDropzone.addEventListener('click', () => uploadFileInput.click());
        uploadFileInput.addEventListener('change', (e) => handleFiles(e.target.files));

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            uploadDropzone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            uploadDropzone.addEventListener(eventName, () => uploadDropzone.classList.add('active'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            uploadDropzone.addEventListener(eventName, () => uploadDropzone.classList.remove('active'), false);
        });

        uploadDropzone.addEventListener('drop', (e) => {
            handleFiles(e.dataTransfer.files);
        }, false);
    }

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    async function handleFiles(files) {
        if (files.length === 0) return;
        uploadProgressContainer.innerHTML = '';
        
        let allFiles = [];
        for (const file of files) {
            allFiles.push(file);
        }

        const items = await getItemsFromDataTransfer(files);
        uploadFiles(items);
    }

    async function getItemsFromDataTransfer(files) {
        const fileEntries = [];
        const directoryEntries = [];
    
        for (const file of files) {
            // This is a simplified check. A proper check might involve more heuristics
            // as there's no direct way to know if a 'file' object from drop is a directory.
            // We rely on the user dropping folders.
            if (file.size === 0 && file.type === '') {
                directoryEntries.push(file);
            } else {
                fileEntries.push(file);
            }
        }
    
        const allFiles = [];
        for (const file of fileEntries) {
            allFiles.push({ file: file, relativePath: file.name });
        }
    
        // For directories, we can't actually get the files due to browser security.
        // We'll just show a message.
        if (directoryEntries.length > 0) {
            alert('资料夹上传功能需要透过点击 "选择资料夹" 按钮来使用，直接拖曳资料夹可能无法正确读取内容。');
        }
        
        // Let's use a standard file input for folder selection
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.onchange = e => {
            for (const file of e.target.files) {
                allFiles.push({ file: file, relativePath: file.webkitRelativePath });
            }
        };
        // This is a placeholder, real folder upload needs a different button.
        
        return allFiles;
    }

    async function uploadFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        
        const filesToUpload = [];
        const fileInfoForCheck = [];
        for (const item of fileList) {
            // Check if it's a file object from input or a wrapper
            const file = item.file ? item.file : item;
            const relativePath = item.relativePath ? item.relativePath : file.name;
            filesToUpload.push({file, relativePath});
            fileInfoForCheck.push({name: file.name, relativePath});
        }
        
        // 1. Check for conflicts
        const existenceResponse = await axios.post('/api/check-existence', {
            files: fileInfoForCheck,
            folderId: currentFolderId
        });
        const existingFiles = existenceResponse.data.files.filter(f => f.exists);
        const overwritePaths = [];

        if (existingFiles.length > 0) {
            const fileNames = existingFiles.map(f => f.relativePath).join('\n');
            if (!confirm(`以下档案已存在，是否要覆盖？\n\n${fileNames}`)) {
                // Filter out the conflicting files if user chooses not to overwrite
                const existingPaths = new Set(existingFiles.map(f => f.relativePath));
                const filteredFilesToUpload = filesToUpload.filter(f => !existingPaths.has(f.relativePath));
                // If all files were conflicts and user cancelled, stop here.
                if(filteredFilesToUpload.length === 0) {
                    uploadModal.style.display = 'none';
                    return;
                }
                filesToUpload.length = 0; // clear array
                filesToUpload.push(...filteredFilesToUpload);
            } else {
                existingFiles.forEach(f => overwritePaths.push(f.relativePath));
            }
        }

        // 2. Prepare FormData
        const formData = new FormData();
        const relativePathsForUpload = [];
        filesToUpload.forEach(item => {
            formData.append('files', item.file, item.file.name);
            relativePathsForUpload.push(item.relativePath);
        });

        formData.append('folderId', currentFolderId);
        formData.append('overwritePaths', JSON.stringify(overwritePaths));
        formData.append('relativePaths', relativePathsForUpload);

        // 3. Perform upload with progress
        try {
            uploadProgressContainer.innerHTML = `<div class="upload-progress-bar"><div></div></div>`;
            const progressBar = uploadProgressContainer.querySelector('.upload-progress-bar > div');

            await axios.post('/upload', formData, {
                onUploadProgress: (progressEvent) => {
                    const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    progressBar.style.width = percentCompleted + '%';
                    progressBar.textContent = percentCompleted + '%';
                }
            });
            
            uploadModal.style.display = 'none';
            loadFolder(currentFolderId, true);

        } catch (error) {
            console.error('Upload failed:', error);
            uploadProgressContainer.innerHTML = `<p style="color:red;">上传失败: ${error.response?.data?.message || error.message}</p>`;
        }
    }


    // --- Move System ---

    function setupMoveSystem() {
        confirmMoveBtn.addEventListener('click', async () => {
            const selectedFolder = document.querySelector('.folder-tree-item.selected');
            if (!selectedFolder) {
                alert('请选择一个目标资料夹。');
                return;
            }
            const targetFolderId = selectedFolder.dataset.id;
            const selectedItems = getSelectedItems();
            const itemIds = selectedItems.map(item => item.id);

            try {
                // 1. Check for conflicts before moving
                const conflictResponse = await axios.post('/api/check-move-conflict', {
                    itemIds,
                    targetFolderId
                });

                if (conflictResponse.data.error) {
                    alert(conflictResponse.data.error);
                    moveModal.style.display = 'none';
                    return;
                }

                const { fileConflicts, folderConflicts } = conflictResponse.data;
                const overwriteList = [];
                const mergeList = [];

                let proceed = true;

                if (fileConflicts.length > 0) {
                    if (!confirm(`目标资料夹中已存在同名档案: \n\n${fileConflicts.join('\n')}\n\n是否覆盖这些档案？`)) {
                        // If user cancels, we might want to stop the whole operation or just skip these files.
                        // For simplicity, we stop here.
                        proceed = false; 
                    } else {
                        overwriteList.push(...fileConflicts);
                    }
                }
                
                if (proceed && folderConflicts.length > 0) {
                     if (!confirm(`目标资料夹中已存在同名资料夹: \n\n${folderConflicts.join('\n')}\n\n是否合并这些资料夹？`)) {
                        proceed = false;
                    } else {
                        mergeList.push(...folderConflicts);
                    }
                }

                if (!proceed) {
                    moveModal.style.display = 'none';
                    return;
                }
                
                // 2. Perform the move
                await axios.post('/api/move', {
                    itemIds: itemIds,
                    targetFolderId: targetFolderId,
                    overwriteList,
                    mergeList
                });
                
                moveModal.style.display = 'none';
                loadFolder(currentFolderId, true);

            } catch (error) {
                alert(error.response?.data?.message || '移动失败。');
            }
        });
    }

    async function openMoveModal() {
        const selectedItems = getSelectedItems();
        if (selectedItems.length === 0) return;
        
        try {
            const response = await axios.get('/api/folders');
            const folders = response.data;
            const tree = buildTree(folders, null);
            folderTreeContainer.innerHTML = '';
            renderTree(tree, folderTreeContainer, 0, selectedItems.map(i => i.id));
            moveModal.style.display = 'flex';
        } catch (error) {
            alert('无法加载资料夹列表。');
        }
    }

    function buildTree(folders, parentId) {
        return folders
            .filter(folder => folder.parent_id === parentId)
            .map(folder => ({ ...folder, children: buildTree(folders, folder.id) }));
    }

    function renderTree(nodes, container, level, disabledIds = []) {
        nodes.forEach(node => {
            const item = document.createElement('div');
            item.className = 'folder-tree-item';
            item.dataset.id = node.id;
            item.style.paddingLeft = `${level * 20}px`;

            if (disabledIds.includes(String(node.id))) {
                item.classList.add('disabled');
            } else {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.folder-tree-item.selected').forEach(el => el.classList.remove('selected'));
                    item.classList.add('selected');
                });
            }

            item.innerHTML = `<i class="fas fa-folder"></i> ${node.name}`;
            container.appendChild(item);

            if (node.children.length > 0) {
                renderTree(node.children, container, level + 1, disabledIds);
            }
        });
    }
    
    // --- Share System ---
    
    function setupShareSystem() {
        confirmShareBtn.addEventListener('click', async () => {
            const itemId = confirmShareBtn.dataset.itemId;
            const itemType = confirmShareBtn.dataset.itemType;
            const expiresIn = document.getElementById('share-expires-in').value;
            
            try {
                const response = await axios.post('/share', {
                    itemId, itemType, expiresIn
                });
                if (response.data.success) {
                    shareUrlInput.value = response.data.url;
                    shareLinkContainer.style.display = 'block';
                } else {
                    alert('建立分享连结失败。');
                }
            } catch (error) {
                 alert('建立分享连结失败：' + (error.response?.data?.message || error.message));
            }
        });
        
        copyShareLinkBtn.addEventListener('click', () => {
            shareUrlInput.select();
            document.execCommand('copy');
            alert('连结已复制！');
        });
    }
    
    function openShareModal(itemId, itemType) {
        shareLinkContainer.style.display = 'none';
        shareUrlInput.value = '';
        confirmShareBtn.dataset.itemId = itemId;
        confirmShareBtn.dataset.itemType = itemType;
        shareModal.style.display = 'flex';
    }
    
    async function cancelShare(itemId, itemType) {
        if (!confirm('确定要取消此项目的分享吗？')) return;
        try {
            await axios.post('/api/cancel-share', { itemId, itemType });
            alert('分享已取消。');
        } catch(error) {
            alert('取消分享失败: ' + (error.response?.data?.message || error.message));
        }
    }

    // --- Text Editor System ---

    function setupEditorSystem() {
        saveTextFileBtn.addEventListener('click', async () => {
            const fileName = editorFileName.value.trim();
            const content = editorTextarea.value;
            if (!fileName) {
                alert('档名不能为空。');
                return;
            }
            if(!fileName.endsWith('.txt')) {
                alert('目前只支援 .txt 格式的档案。');
                return;
            }

            try {
                await axios.post('/api/text-file', {
                    mode: editorMode,
                    fileId: editorFileId,
                    folderId: currentFolderId,
                    fileName,
                    content
                });
                editorModal.style.display = 'none';
                loadFolder(currentFolderId, true);
            } catch (error) {
                alert('储存档案失败: ' + (error.response?.data?.message || '伺服器错误'));
            }
        });
    }

    async function openTextEditor(mode, fileId = null) {
        editorMode = mode;
        editorFileId = fileId;
        editorTextarea.value = '';
        editorFileName.value = '';

        if (mode === 'edit' && fileId) {
            try {
                showLoading();
                const [infoRes, contentRes] = await Promise.all([
                    axios.get(`/api/file-info/${fileId}`),
                    axios.get(`/file/content/${fileId}`)
                ]);
                editorFileName.value = infoRes.data.fileName;
                editorTextarea.value = contentRes.data;
            } catch (error) {
                alert('无法加载档案内容。');
                hideLoading();
                return;
            }
        }
        
        hideLoading();
        editorModal.style.display = 'flex';
    }


    // --- Initialization ---

    function init() {
        const initialFolderId = window.location.pathname.split('/').pop();
        loadFolder(initialFolderId || 1);
        setupEventListeners();
    }
    
    init();
});
