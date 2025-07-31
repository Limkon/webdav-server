document.addEventListener('DOMContentLoaded', () => {
    // DOM 元素 (大部分维持不变)
    const homeLink = document.getElementById('homeLink');
    const itemGrid = document.getElementById('itemGrid');
    const breadcrumb = document.getElementById('breadcrumb');
    const actionBar = document.getElementById('actionBar');
    const selectionCountSpan = document.getElementById('selectionCount');
    const createFolderBtn = document.getElementById('createFolderBtn');
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    const multiSelectBtn = document.getElementById('multiSelectBtn');
    const renameBtn = document.getElementById('renameBtn');
    const moveBtn = document.getElementById('moveBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const moveModal = document.getElementById('moveModal');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    const uploadModal = document.getElementById('uploadModal');
    const showUploadModalBtn = document.getElementById('showUploadModalBtn');
    const closeUploadModalBtn = document.getElementById('closeUploadModalBtn');
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const dropZone = document.getElementById('dropZone');

    // 状态
    let isMultiSelectMode = false;
    let currentPath = '/';
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map(); // key: virtualId, value: { type, name, path }
    let moveTargetFolderPath = null;

    const formatBytes = (bytes, decimals = 2) => {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    };
    
    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification global ${type}`;
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 5000);
    }

    const loadFolderContents = async (path) => {
        try {
            currentPath = path;
            const res = await axios.get(`/api/browse?path=${encodeURIComponent(path)}`);
            currentFolderContents = res.data.contents;
            selectedItems.clear(); // 清空选择
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateActionBar();
        } catch (error) {
            console.error("加载内容失败", error);
            if (error.response && error.response.status === 401) window.location.href = '/login';
            itemGrid.innerHTML = '<p>加载内容失败。</p>';
        }
    };

    const renderBreadcrumb = (path) => {
        breadcrumb.innerHTML = '';
        if (!path || path.length === 0) return;
        path.forEach((p, index) => {
            if (index > 0) breadcrumb.innerHTML += '<span class="separator">/</span>';
            const link = document.createElement(index === path.length - 1 ? 'span' : 'a');
            link.textContent = p.name;
            if (link.tagName === 'A') {
                link.href = '#';
                link.dataset.path = p.id; // id 现在是路径
            }
            breadcrumb.appendChild(link);
        });
    };

    const renderItems = (folders, files) => {
        itemGrid.innerHTML = '';
        const allItems = [...folders, ...files];
        if (allItems.length === 0) {
            itemGrid.innerHTML = '<p>此目录是空的。</p>';
            return;
        }
        allItems.forEach(item => itemGrid.appendChild(createItemCard(item)));
    };
    
    const createItemCard = (item) => {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.dataset.id = item.id; // virtualId
        card.dataset.type = item.type;
        card.dataset.name = item.name;
        
        const itemPath = pathJoin(currentPath, item.name);
        card.dataset.path = itemPath;

        const iconHtml = item.type === 'file' ? '<i class="fas fa-file"></i>' : '<i class="fas fa-folder"></i>';
        card.innerHTML = `<div class="item-icon">${iconHtml}</div><div class="item-info"><h5 title="${item.name}">${item.name}</h5></div>`;
        if (selectedItems.has(item.id)) card.classList.add('selected');
        return card;
    };

    const updateActionBar = () => {
        const count = selectedItems.size;
        selectionCountSpan.textContent = `已选择 ${count} 个项目`;
        const isRoot = currentPath === '/';

        createFolderBtn.disabled = isRoot;
        renameBtn.disabled = count !== 1 || isRoot;
        moveBtn.disabled = count === 0 || isRoot;
        deleteBtn.disabled = count === 0 || isRoot;
        downloadBtn.disabled = count === 0 || Array.from(selectedItems.values()).some(item => item.type === 'folder');
    };
    
    const rerenderSelection = () => {
        document.querySelectorAll('.item-card').forEach(el => {
            el.classList.toggle('selected', selectedItems.has(el.dataset.id));
        });
    };

    function pathJoin(...parts) {
        const newPath = path.posix.join(...parts);
        return newPath === '.' ? '/' : newPath;
    }

    // --- 事件监听 ---
    
    // 单击选择/多选
    itemGrid.addEventListener('click', (e) => {
        const target = e.target.closest('.item-card');
        if (!target) return;
        const id = target.dataset.id;
        const { type, name, path } = target.dataset;

        if (isMultiSelectMode) {
            if (selectedItems.has(id)) selectedItems.delete(id);
            else selectedItems.set(id, { type, name, path });
        } else {
            const isSelected = selectedItems.has(id);
            selectedItems.clear();
            if (!isSelected) selectedItems.set(id, { type, name, path });
        }
        rerenderSelection();
        updateActionBar();
    });

    // 双击进入目录
    itemGrid.addEventListener('dblclick', (e) => {
        const target = e.target.closest('.item-card');
        if (target && target.dataset.type === 'folder') {
            const path = target.dataset.path;
            window.history.pushState({ path }, '', `/folder${path}`);
            loadFolderContents(path);
        }
    });

    // 面包屑导航
    breadcrumb.addEventListener('click', e => {
        e.preventDefault();
        const link = e.target.closest('a');
        if (link && link.dataset.path) {
            const path = link.dataset.path;
            window.history.pushState({ path }, '', `/folder${path}`);
            loadFolderContents(path);
        }
    });

    // 浏览器前进/后退
    window.addEventListener('popstate', (e) => {
        const path = e.state ? e.state.path : '/';
        loadFolderContents(path);
    });

    // 多选模式切换
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
    
    // 全选
    selectAllBtn.addEventListener('click', () => {
        isMultiSelectMode = true;
        multiSelectBtn.classList.add('active');
        const allVisibleItems = [...currentFolderContents.folders, ...currentFolderContents.files];
        const allSelected = selectedItems.size === allVisibleItems.length;

        selectedItems.clear();
        if (!allSelected) {
            allVisibleItems.forEach(item => {
                const itemPath = pathJoin(currentPath, item.name);
                selectedItems.set(item.id, { type: item.type, name: item.name, path: itemPath });
            });
        }
        rerenderSelection();
        updateActionBar();
    });

    // 建立资料夹
    createFolderBtn.addEventListener('click', async () => {
        const name = prompt('请输入新资料夹的名称：');
        if (name && name.trim()) {
            try {
                const newFolderPath = pathJoin(currentPath, name.trim());
                await axios.post('/api/folder', { path: newFolderPath });
                loadFolderContents(currentPath);
            } catch (error) { alert(error.response?.data?.message || '建立失败'); }
        }
    });

    // 重新命名
    renameBtn.addEventListener('click', async () => {
        if (renameBtn.disabled) return;
        const [id, item] = selectedItems.entries().next().value;
        const newName = prompt('请输入新的名称:', item.name);
        if (newName && newName.trim() && newName !== item.name) {
            try {
                await axios.post('/rename', { path: item.path, newName: newName.trim() });
                loadFolderContents(currentPath);
            } catch (error) {
                alert('重命名失败: ' + (error.response?.data?.message || '服务器错误'));
            }
        }
    });

    // 删除
    deleteBtn.addEventListener('click', async () => {
        if (selectedItems.size === 0) return;
        if (!confirm(`确定要删除这 ${selectedItems.size} 个项目吗？`)) return;
        
        try {
            const pathsToDelete = Array.from(selectedItems.values()).map(item => item.path);
            await axios.post('/delete-multiple', { paths: pathsToDelete });
            loadFolderContents(currentPath);
        } catch (error) { alert('删除失败，请重试。'); }
    });

    // 下载
    downloadBtn.addEventListener('click', () => {
        if (downloadBtn.disabled) return;
        const selectedFiles = Array.from(selectedItems.values()).filter(item => item.type === 'file');
        if (selectedFiles.length === 1) {
            window.location.href = `/download?path=${encodeURIComponent(selectedFiles[0].path)}`;
        }
    });
    
    // 显示上传 modal
    showUploadModalBtn.addEventListener('click', () => {
        if (currentPath === '/') {
            showNotification('请先进入一个挂载点再上传档案。', 'error');
            return;
        }
        uploadModal.style.display = 'flex';
    });
    closeUploadModalBtn.addEventListener('click', () => uploadModal.style.display = 'none');

    // 处理上传
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const files = fileInput.files;
        if (files.length === 0) return showNotification('请选择档案', 'error');
        
        const formData = new FormData();
        formData.append('path', currentPath);
        for (const file of files) {
            formData.append('files', file);
        }
        
        try {
            await axios.post('/upload', formData);
            uploadModal.style.display = 'none';
            showNotification('上传成功！', 'success');
            loadFolderContents(currentPath);
        } catch (error) {
            showNotification('上传失败: ' + (error.response?.data?.message || '伺服器错误'), 'error');
        }
    });
    
    // 拖拽上传
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); });
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
        
        if (currentPath === '/') {
            showNotification('请先进入一个挂载点再上传档案。', 'error');
            return;
        }

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const formData = new FormData();
            formData.append('path', currentPath);
            for (const file of files) {
                formData.append('files', file);
            }
            try {
                showNotification('正在上传...', 'info');
                await axios.post('/upload', formData);
                showNotification('上传成功!', 'success');
                loadFolderContents(currentPath);
            } catch (error) {
                showNotification('上传失败: ' + (error.response?.data?.message || '伺服器错误'), 'error');
            }
        }
    });

    // 移动
    moveBtn.addEventListener('click', async () => {
        if (moveBtn.disabled) return;
        const sourceMount = currentPath.split('/')[1];
        if (!sourceMount) return;

        moveTargetFolderPath = null;
        confirmMoveBtn.disabled = true;
        folderTree.innerHTML = '正在加载目录...';
        moveModal.style.display = 'flex';

        try {
            const configs = (await axios.get('/api/admin/webdav-configs')).data;
            const currentMountConfig = configs.find(c => c.name === sourceMount);
            if (!currentMountConfig) throw new Error("找不到当前挂载点");

            const tree = await buildFolderTreeForMount(sourceMount, '/');
            folderTree.innerHTML = '';
            folderTree.appendChild(tree);
        } catch(e) {
            folderTree.innerHTML = '无法加载目录列表';
        }
    });

    async function buildFolderTreeForMount(mountName, path) {
        const container = document.createElement('div');
        const res = await axios.get(`/api/browse?path=${encodeURIComponent(pathJoin(mountName, path))}`);
        const folders = res.data.contents.folders;
        
        folders.forEach(folder => {
            const item = document.createElement('div');
            item.className = 'folder-item';
            item.textContent = folder.name;
            item.dataset.path = pathJoin(mountName, path, folder.name);
            container.appendChild(item);
        });
        return container;
    }

    folderTree.addEventListener('click', async (e) => {
        const target = e.target.closest('.folder-item');
        if (!target) return;
        
        const previouslySelected = folderTree.querySelector('.folder-item.selected');
        if(previouslySelected) previouslySelected.classList.remove('selected');
        
        target.classList.add('selected');
        moveTargetFolderPath = target.dataset.path;
        confirmMoveBtn.disabled = false;
        
        // 展开子目录
        const subTree = await buildFolderTreeForMount(target.dataset.path.split('/')[1], target.dataset.path.substring(target.dataset.path.indexOf('/')+1) );
        target.appendChild(subTree);
    });
    
    confirmMoveBtn.addEventListener('click', async () => {
        if (!moveTargetFolderPath) return;
        
        const sourcePaths = Array.from(selectedItems.values()).map(i => i.path);
        
        try {
            await axios.post('/api/move', { sourcePaths, targetPath: moveTargetFolderPath });
            moveModal.style.display = 'none';
            loadFolderContents(currentPath);
            showNotification('移动成功！', 'success');
        } catch(e) {
            alert(e.response?.data?.message || '移动失败');
        }
    });
    
    cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');


    // 登出和修改密码
    logoutBtn.addEventListener('click', () => window.location.href = '/logout');
    changePasswordBtn.addEventListener('click', async () => {
        const oldPassword = prompt('请输入您的旧密码：');
        if (!oldPassword) return;
        const newPassword = prompt('请输入您的新密码 (至少 4 个字元)：');
        if (!newPassword || newPassword.length < 4) return alert('密码长度至少需要 4 个字元。');
        try {
            await axios.post('/api/user/change-password', { oldPassword, newPassword });
            alert('密码修改成功！');
        } catch (error) {
            alert('密码修改失败：' + (error.response?.data?.message || '伺服器错误'));
        }
    });


    // 初始化
    const initialPath = window.location.pathname.startsWith('/folder') ? window.location.pathname.substring(7) || '/' : '/';
    loadFolderContents(initialPath);
});
