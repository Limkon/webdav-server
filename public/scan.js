document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const webdavSelect = document.getElementById('webdav-select');
    const scanBtn = document.getElementById('scan-btn');
    const scanLog = document.getElementById('scan-log');
    let allUsers = [];
    let allWebdavs = [];

    async function loadUsers() {
        try {
            const response = await axios.get('/api/admin/all-users');
            allUsers = response.data;
            userSelect.innerHTML = '<option value="" disabled selected>-- 请选择使用者 --</option>';
            allUsers.forEach(user => {
                const option = new Option(user.username, user.id);
                userSelect.appendChild(option);
            });
        } catch (error) {
            logMessage('无法加载使用者列表', 'error');
        }
    }

    async function loadWebdavConfigs(userId) {
        webdavSelect.innerHTML = '<option value="">加载中...</option>';
        webdavSelect.disabled = true;
        scanBtn.disabled = true;
        if (!userId) {
            webdavSelect.innerHTML = '<option value="">请先选择使用者</option>';
            return;
        }
        try {
            const response = await axios.get(`/api/admin/webdav-configs?userId=${userId}`);
            allWebdavs = response.data;
            webdavSelect.innerHTML = '<option value="" disabled selected>-- 请选择挂载点 --</option>';
            if (allWebdavs.length > 0) {
                allWebdavs.forEach(config => {
                    const option = new Option(`${config.mount_name} (${config.url})`, config.id);
                    webdavSelect.appendChild(option);
                });
                webdavSelect.disabled = false;
            } else {
                webdavSelect.innerHTML = '<option value="">此使用者无挂载点</option>';
            }
        } catch (error) {
            webdavSelect.innerHTML = '<option value="">加载失败</option>';
            logMessage('加载 WebDAV 设定失败', 'error');
        }
    }

    function logMessage(message, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        scanLog.appendChild(line);
        scanLog.scrollTop = scanLog.scrollHeight;
    }

    function disableControls(disabled) {
        scanBtn.disabled = disabled;
        userSelect.disabled = disabled;
        webdavSelect.disabled = disabled;
    }

    async function startScan() {
        const userId = userSelect.value;
        const webdavConfigId = webdavSelect.value;

        if (!userId || !webdavConfigId) {
            alert('请先选择一个使用者和 WebDAV 挂载点！');
            return;
        }
        
        scanLog.innerHTML = '';
        logMessage(`开始为使用者 ID ${userId} 扫描 WebDAV 挂载点 ID ${webdavConfigId}`, 'info');
        disableControls(true);

        try {
            const response = await axios.post(`/api/scan/webdav`, { userId, webdavConfigId });
            const logs = response.data.log;
            if(logs && logs.length > 0) {
               logs.forEach(log => logMessage(log.message, log.type));
            }
            logMessage('扫描完成！', 'success');
        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
        } finally {
            disableControls(false);
        }
    }

    userSelect.addEventListener('change', () => loadWebdavConfigs(userSelect.value));
    webdavSelect.addEventListener('change', () => {
        scanBtn.disabled = !webdavSelect.value;
    });
    scanBtn.addEventListener('click', startScan);

    loadUsers();
});
