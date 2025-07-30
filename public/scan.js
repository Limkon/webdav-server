document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const scanLocalBtn = document.getElementById('scan-local-btn');
    const webdavScanButtonsContainer = document.getElementById('webdav-scan-buttons');
    const scanLog = document.getElementById('scan-log');

    // 加载所有使用者到下拉选单
    async function loadUsers() {
        try {
            const response = await axios.get('/api/admin/all-users');
            userSelect.innerHTML = '<option value="" disabled selected>-- 请选择一个使用者 --</option>';
            response.data.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = user.username;
                userSelect.appendChild(option);
            });
        } catch (error) {
            logMessage('无法加载使用者列表: ' + (error.response?.data?.message || error.message), 'error');
        }
    }

    // *** 新生：加载并建立 WebDAV 扫描按钮 ***
    async function loadWebdavButtons() {
        try {
            const response = await axios.get('/api/admin/webdav');
            const webdavConfigs = response.data;
            
            webdavConfigs.forEach(config => {
                const button = document.createElement('button');
                button.className = 'upload-link-btn scan-webdav-btn'; // 新增 class 以便统一处理
                button.style.backgroundColor = '#17a2b8';
                button.dataset.webdavId = config.id; // 储存设定的 ID
                button.innerHTML = `<i class="fas fa-server"></i> 扫描 WebDAV: ${config.name}`;
                webdavScanButtonsContainer.appendChild(button);
            });

        } catch (error) {
            logMessage('无法加载 WebDAV 设定列表: ' + (error.response?.data?.message || error.message), 'warn');
        }
    }


    function logMessage(message, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        scanLog.appendChild(line);
        scanLog.scrollTop = scanLog.scrollHeight;
    }

    function disableButtons(disabled) {
        scanLocalBtn.disabled = disabled;
        userSelect.disabled = disabled;
        // 停用所有 WebDAV 按钮
        document.querySelectorAll('.scan-webdav-btn').forEach(btn => btn.disabled = disabled);
    }

    // *** 修改：startScan 函数以处理不同的储存类型和 WebDAV ID ***
    async function startScan(storageType, webdavId = null) {
        const userId = userSelect.value;
        if (!userId) {
            alert('请先选择一个要汇入的使用者！');
            return;
        }
        
        scanLog.innerHTML = '';
        const scanTargetName = webdavId ? `WebDAV ID: ${webdavId}` : storageType.toUpperCase();
        logMessage(`开始扫描 ${scanTargetName} 储存，为使用者 ID: ${userId}`, 'info');
        disableButtons(true);

        try {
            const payload = { userId };
            if (webdavId) {
                payload.webdavId = webdavId;
            }

            const response = await axios.post(`/api/scan/${storageType}`, payload);
            const logs = response.data.log;
            logs.forEach(log => logMessage(log.message, log.type));
            logMessage('扫描完成！', 'success');

        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
        } finally {
            disableButtons(false);
        }
    }

    scanLocalBtn.addEventListener('click', () => startScan('local'));

    // *** 新生：为动态产生的 WebDAV 按钮容器新增事件委托 ***
    webdavScanButtonsContainer.addEventListener('click', (e) => {
        const target = e.target.closest('.scan-webdav-btn');
        if (target) {
            const webdavId = target.dataset.webdavId;
            if(webdavId) {
                startScan('webdav', webdavId);
            }
        }
    });

    loadUsers();
    loadWebdavButtons(); // 页面加载时执行
});
