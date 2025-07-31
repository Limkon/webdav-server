document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const mountSelect = document.getElementById('mount-select');
    const scanWebdavBtn = document.getElementById('scan-webdav-btn');
    const scanLog = document.getElementById('scan-log');

    async function loadMounts() {
        try {
            const response = await axios.get('/api/admin/webdav');
            mountSelect.innerHTML = '<option value="" disabled selected>-- 请选择一个挂载点 --</option>';
            response.data.forEach(mount => {
                const option = document.createElement('option');
                option.value = mount.id;
                option.textContent = mount.name;
                mountSelect.appendChild(option);
            });
        } catch (error) {
            logMessage('无法加载挂载点列表: ' + (error.response?.data?.message || error.message), 'error');
        }
    }

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
        mountSelect.disabled = disabled;
    }

    async function startScan() {
        const userId = userSelect.value;
        const mountId = mountSelect.value;
        if (!userId || !mountId) {
            alert('请先选择一个挂载点和一个使用者！');
            return;
        }
        
        scanLog.innerHTML = '';
        logMessage(`开始扫描 WebDAV 挂载点 ID: ${mountId}，汇入到使用者 ID: ${userId}`, 'info');
        disableButtons(true);

        try {
            const response = await axios.post(`/api/scan/webdav`, { userId, mountId });
            const logs = response.data.log;
            logs.forEach(log => logMessage(log.message, log.type));
            logMessage('扫描完成！', 'success');

        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
            if (error.response?.data?.log) {
                error.response.data.log.forEach(log => logMessage(log.message, log.type));
            }
        } finally {
            disableButtons(false);
        }
    }

    scanWebdavBtn.addEventListener('click', startScan);

    loadUsers();
    loadMounts();
});
