document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const webdavSelect = document.getElementById('webdav-select');
    const scanWebdavBtn = document.getElementById('scan-webdav-btn');
    const scanLog = document.getElementById('scan-log');

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
    
    async function loadWebdavMounts() {
        try {
            const response = await axios.get('/api/admin/webdav');
            webdavSelect.innerHTML = '<option value="" disabled selected>-- 请选择挂载点 --</option>';
            if (response.data.length > 0) {
                response.data.forEach(mount => {
                    const option = document.createElement('option');
                    option.value = mount.name;
                    option.textContent = mount.name;
                    webdavSelect.appendChild(option);
                });
            } else {
                 webdavSelect.innerHTML = '<option value="" disabled selected>请先在后台新增 WebDAV</option>';
            }
        } catch (error) {
             logMessage('无法加载 WebDAV 挂载点列表: ' + (error.response?.data?.message || error.message), 'error');
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
        scanWebdavBtn.disabled = disabled;
        userSelect.disabled = disabled;
        webdavSelect.disabled = disabled;
    }

    async function startScan() {
        const userId = userSelect.value;
        const mountName = webdavSelect.value;

        if (!userId) {
            alert('请先选择一个要汇入的使用者！');
            return;
        }
        if (!mountName) {
            alert('请选择要扫描的 WebDAV 挂载点！');
            return;
        }
        
        scanLog.innerHTML = '';
        logMessage(`开始扫描 WebDAV [${mountName}]，为使用者 ID: ${userId}`, 'info');
        disableButtons(true);

        try {
            const response = await axios.post(`/api/scan/webdav`, { userId, mountName });
            const logs = response.data.log;
            logs.forEach(log => logMessage(log.message, log.type));
            logMessage('扫描完成！', 'success');

        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
        } finally {
            disableButtons(false);
        }
    }

    scanWebdavBtn.addEventListener('click', () => startScan());

    loadUsers();
    loadWebdavMounts();
});
