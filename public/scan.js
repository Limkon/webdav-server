document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const scanWebdavBtn = document.getElementById('scan-webdav-btn');
    const scanLog = document.getElementById('scan-log');
    // --- *** 关键修正 开始 *** ---
    const mountSelect = document.getElementById('mount-select');

    // 加载所有 WebDAV 挂载点到下拉菜单
    async function loadMounts() {
        try {
            const response = await axios.get('/api/admin/webdav');
            mountSelect.innerHTML = '<option value="" disabled selected>-- 请选择一个挂载点 --</option>';
            response.data.forEach(mount => {
                const option = document.createElement('option');
                option.value = mount.id;
                option.textContent = mount.mount_name;
                mountSelect.appendChild(option);
            });
        } catch (error) {
            logMessage('无法加载 WebDAV 挂载点列表: ' + (error.response?.data?.message || error.message), 'error');
        }
    }
    // --- *** 关键修正 结束 *** ---

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
        // --- *** 关键修正 开始 *** ---
        mountSelect.disabled = disabled;
        // --- *** 关键修正 结束 *** ---
    }

    async function startScan(storageType) {
        const userId = userSelect.value;
        // --- *** 关键修正 开始 *** ---
        const mountId = mountSelect.value;
        const selectedMountName = mountSelect.options[mountSelect.selectedIndex]?.text;
        
        if (!userId) {
            alert('请先选择一个要汇入的使用者！');
            return;
        }
        if (!mountId) {
            alert('请选择一个要扫描的 WebDAV 挂载点！');
            return;
        }
        // --- *** 关键修正 结束 *** ---
        
        scanLog.innerHTML = '';
        logMessage(`开始扫描 ${storageType.toUpperCase()} 储存 [${selectedMountName}]，为使用者 ID: ${userId}`, 'info');
        disableButtons(true);

        try {
            // --- *** 关键修正 开始 *** ---
            const response = await axios.post(`/api/scan/${storageType}`, { userId, mountId });
            // --- *** 关键修正 结束 *** ---
            const logs = response.data.log;
            logs.forEach(log => logMessage(log.message, log.type));
            logMessage('扫描完成！', 'success');

        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
        } finally {
            disableButtons(false);
        }
    }

    scanWebdavBtn.addEventListener('click', () => startScan('webdav'));

    loadUsers();
    // --- *** 关键修正 开始 *** ---
    loadMounts();
    // --- *** 关键修正 结束 *** ---
});
