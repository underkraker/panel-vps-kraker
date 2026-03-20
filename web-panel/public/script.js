let userToken = localStorage.getItem('panel_token');
let protocolsLoaded = false;
let canManageSystem = true;
let currentEditingUser = null;

async function apiFetch(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (userToken) options.headers['Authorization'] = `Bearer ${userToken}`;
    
    const response = await fetch(url, options);
    if (response.status === 401) {
        logout();
        throw new Error('Sesión expirada o no autorizada');
    }
    return response;
}

function checkSession() {
    if (!userToken) {
        document.getElementById('login-screen').style.display = 'flex';
    } else {
        document.getElementById('login-screen').style.display = 'none';
        loadProtocols();
        updateStatus();
    }
}

async function login() {
    const password = document.getElementById('admin-password').value;
    const errorEl = document.getElementById('login-error');

    if (!password) {
        errorEl.innerText = 'Debes ingresar una contraseña';
        errorEl.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        if (data.token) {
            userToken = data.token;
            localStorage.setItem('panel_token', userToken);
            errorEl.style.display = 'none';
            document.getElementById('admin-password').value = '';
            checkSession();
        } else {
            errorEl.style.display = 'block';
        }
    } catch (error) {
        errorEl.innerText = 'Error de conexión';
        errorEl.style.display = 'block';
    }
}

function logout() {
    userToken = null;
    localStorage.removeItem('panel_token');
    checkSession();
}

function protocolIcon(name) {
    const normalized = name.toLowerCase();
    if (normalized.includes('v2ray') || normalized.includes('vless')) return 'fa-vial';
    if (normalized.includes('trojan')) return 'fa-shield-virus';
    if (normalized.includes('ssh') || normalized.includes('dropbear')) return 'fa-terminal';
    if (normalized.includes('shadow')) return 'fa-cloud';
    if (normalized.includes('socks')) return 'fa-bolt';
    if (normalized.includes('badvpn')) return 'fa-shield-alt';
    if (normalized.includes('iptables')) return 'fa-network-wired';
    if (normalized.includes('clash')) return 'fa-layer-group';
    return 'fa-tools';
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderProtocolCards(items, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items.length) {
        container.innerHTML = '<div class="card control-card"><h3>Sin elementos disponibles</h3></div>';
        return;
    }

    container.innerHTML = items.map((protocol) => {
        const actions = protocol.actions.map((action, index) => {
            const kind = index === 0 ? 'btn-primary' : 'btn-secondary';
            const disabled = canManageSystem ? '' : 'disabled';
            const title = canManageSystem ? '' : 'title="Requiere ejecutar el panel como root"';
            return `<button class="btn ${kind} btn-small" ${disabled} ${title} onclick="runProtocolAction('${escapeHtml(protocol.id)}', '${escapeHtml(action.id)}', this)">${escapeHtml(action.label)}</button>`;
        }).join('');

        return `
            <div class="card protocol-card">
                <div class="protocol-header">
                    <div>
                        <i class="fas ${protocolIcon(protocol.name)}"></i>
                        <h4>${escapeHtml(protocol.name)}</h4>
                    </div>
                    <span class="badge ${protocol.isOnline ? 'badge-on' : 'badge-off'}" id="status-${escapeHtml(protocol.id)}">${protocol.isOnline ? 'ON' : 'OFF'}</span>
                </div>
                <p>${escapeHtml(protocol.description || 'Sin descripción')}</p>
                <p>Puerto: <span class="accent-text">${escapeHtml(protocol.portLabel || 'N/A')}</span></p>
                <div class="card-actions">
                    ${actions}
                </div>
            </div>
        `;
    }).join('');
}

async function loadProtocols(forceReload = false) {
    if (protocolsLoaded && !forceReload) return;

    try {
        const response = await apiFetch('/api/protocols');
        const data = await response.json();
        const list = Array.isArray(data.protocols) ? data.protocols : [];
        renderProtocolCards(list.filter(item => item.group === 'tunnels'), 'tunnels-grid');
        renderProtocolCards(list.filter(item => item.group === 'tools'), 'tools-grid');
        protocolsLoaded = true;
    } catch (error) {
        const tunnels = document.getElementById('tunnels-grid');
        const tools = document.getElementById('tools-grid');
        if (tunnels) tunnels.innerHTML = '<div class="card control-card"><h3>Error cargando túneles</h3></div>';
        if (tools) tools.innerHTML = '<div class="card control-card"><h3>Error cargando herramientas</h3></div>';
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJobCompletion(jobId, outputElement) {
    const startedAt = Date.now();
    const timeoutMs = 10 * 60 * 1000;

    while (Date.now() - startedAt < timeoutMs) {
        const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        const job = await response.json();
        if (!response.ok) {
            throw new Error(job.error || 'No se pudo consultar el estado del job');
        }

        if (outputElement) {
            outputElement.innerText = `Job ${job.id} | estado: ${job.status}`;
        }

        if (job.status === 'completed') {
            return job.output || 'Comando completado exitosamente.';
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
            throw new Error(job.error || 'El job no termino correctamente');
        }

        await sleep(1200);
    }

    throw new Error('Tiempo de espera agotado para el job');
}

async function runProtocolAction(protocolId, actionId, buttonEl) {
    if (!canManageSystem) {
        const outputElement = document.getElementById('output');
        outputElement.innerText = 'Permisos insuficientes: ejecuta el panel como root para administrar el sistema.';
        return;
    }

    const outputElement = document.getElementById('output');
    const oldText = buttonEl ? buttonEl.innerText : '';

    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.innerText = 'Ejecutando...';
    }

    outputElement.innerText = `Ejecutando ${protocolId} (${actionId})...`;

    try {
        const response = await apiFetch(`/api/protocols/${encodeURIComponent(protocolId)}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: actionId })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'No se pudo ejecutar la acción');
        }
        if (data.jobId) {
            outputElement.innerText = `Accion en cola. Job: ${data.jobId}`;
            const finalOutput = await waitForJobCompletion(data.jobId, outputElement);
            outputElement.innerText = finalOutput;
        } else {
            outputElement.innerText = data.output || data.error || 'Acción completada.';
        }
        setTimeout(updateStatus, 1000);
    } catch (error) {
        outputElement.innerText = `Error: ${error.message}`;
    } finally {
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.innerText = oldText;
        }
    }
}

async function updateStatus() {
    try {
        const response = await apiFetch('/api/status');
        const data = await response.json();

        if (data.permissions) {
            const previous = canManageSystem;
            canManageSystem = data.permissions.canManageSystem !== false;

            const permissionAlert = document.getElementById('permission-alert');
            if (permissionAlert) {
                permissionAlert.style.display = canManageSystem ? 'none' : 'block';
            }

            if (previous !== canManageSystem) {
                protocolsLoaded = false;
                loadProtocols(true);
            }
        }
        
        if (document.getElementById('cpu-value')) document.getElementById('cpu-value').innerText = `${data.cpu}%`;
        document.getElementById('cpu-bar').style.width = `${data.cpu}%`;
        
        if (document.getElementById('ram-value')) document.getElementById('ram-value').innerText = `${data.memory}%`;
        document.getElementById('ram-bar').style.width = `${data.memory}%`;
        
        const uptime = Math.floor(data.uptime / 3600);
        document.getElementById('uptime-value').innerText = `${uptime} horas`;

        if (data.network) {
            if (document.getElementById('net-up-value')) document.getElementById('net-up-value').textContent = `${data.network.up} KB/s`;
            if (document.getElementById('net-down-value')) document.getElementById('net-down-value').textContent = `${data.network.down} KB/s`;
        }

        if (data.jobQueue && document.getElementById('queue-state')) {
            const active = data.jobQueue.activeJobId ? 1 : 0;
            document.getElementById('queue-state').textContent = `${data.jobQueue.pending + active}`;
        }

        // Update Protocol Status
        if (data.protocols) {
            Object.keys(data.protocols).forEach(proto => {
                const badge = document.getElementById(`status-${proto}`);
                if (badge) {
                    const isOpen = data.protocols[proto];
                    badge.innerText = isOpen ? 'ON' : 'OFF';
                    badge.className = `badge ${isOpen ? 'badge-on' : 'badge-off'}`;
                }
            });
        }
    } catch (error) {
        console.error('Error fetching status:', error);
    }
}

async function executeCommand(command, args = '') {
    if (!canManageSystem) {
        const outputElement = document.getElementById('output');
        outputElement.innerText = 'Permisos insuficientes: ejecuta el panel como root para administrar el sistema.';
        return;
    }

    const outputElement = document.getElementById('output');

    if (command === 'clean_iptables.sh') {
        const ok = confirm('Esta accion puede limpiar reglas activas de iptables. Deseas continuar?');
        if (!ok) return;
    }

    outputElement.innerText = `Ejecutando ${command} ${args}...`;

    try {
        const response = await apiFetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, args })
        });

        const data = await response.json();
        if (!response.ok || data.error) {
            outputElement.innerText = `Error: ${data.error}`;
        } else {
            if (data.jobId) {
                outputElement.innerText = `Comando en cola. Job: ${data.jobId}`;
                const finalOutput = await waitForJobCompletion(data.jobId, outputElement);
                outputElement.innerText = finalOutput;
            } else {
                outputElement.innerText = data.output || 'Comando completado exitosamente.';
            }
        }
    } catch (error) {
        outputElement.innerText = `Error: ${error.message}`;
    }
}

async function showView(viewId) {
    const views = ['dashboard-view', 'users-view', 'tunnels-view', 'tools-view', 'settings-view'];
    views.forEach(v => {
        const el = document.getElementById(v);
        if (el) el.style.display = v === viewId ? 'block' : 'none';
    });

    // Update active nav link
    document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
    const navMap = {
        'dashboard-view': 'nav-home',
        'users-view': 'nav-users',
        'tunnels-view': 'nav-tunnels',
        'tools-view': 'nav-tools',
        'settings-view': 'nav-settings'
    };
    if (navMap[viewId]) document.getElementById(navMap[viewId]).classList.add('active');

    if (viewId === 'users-view') fetchUsers();
    if (viewId === 'tunnels-view' || viewId === 'tools-view') loadProtocols();
}

async function saveSettings() {
    const newPassword = document.getElementById('settings-password').value;
    if (!newPassword) return alert("Ingresa una contraseña válida.");

    try {
        const response = await apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPassword })
        });
        const data = await response.json();
        alert(data.message);
        document.getElementById('settings-password').value = '';
    } catch (error) {
        alert('Error al guardar ajustes');
    }
}

let allUsers = [];

async function fetchUsers() {
    const listElement = document.getElementById('users-list');
    try {
        const response = await apiFetch('/api/users');
        allUsers = await response.json();
        renderUsers(allUsers);
    } catch (error) {
        listElement.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red">Error cargando usuarios</td></tr>`;
    }
}

function renderUsers(users) {
    const listElement = document.getElementById('users-list');
    const safe = (value) => String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");

    listElement.innerHTML = users.map(u => `
        <tr>
            <td>${u.user}</td>
            <td>${u.date}</td>
            <td>${u.limit}</td>
            <td>
                <button class="action-btn action-btn-solid" title="Editar" onclick="editUser('${safe(u.user)}', '${safe(u.password || '')}', '${safe(u.date)}', '${safe(u.limit)}')">Editar</button>
                <button class="action-btn action-btn-solid delete-btn" title="Eliminar" onclick="deleteUser('${safe(u.user)}')">Eliminar</button>
            </td>
        </tr>
    `).join('');
}

function editUser(username, currentPassword, currentDate, currentLimit) {
    currentEditingUser = username;
    document.getElementById('edit-username').value = username || '';
    document.getElementById('edit-password').value = currentPassword || '';
    document.getElementById('edit-date').value = currentDate || '';
    document.getElementById('edit-limit').value = currentLimit || '';
    showEditUserModal();
}

function showEditUserModal() {
    document.getElementById('edit-user-modal').classList.add('active');
}

function hideEditUserModal() {
    document.getElementById('edit-user-modal').classList.remove('active');
    currentEditingUser = null;
}

async function confirmEditUser() {
    const newUsername = document.getElementById('edit-username').value;
    const newPassword = document.getElementById('edit-password').value;
    const newDate = document.getElementById('edit-date').value;
    const newLimit = document.getElementById('edit-limit').value;

    if (!currentEditingUser) {
        alert('No hay usuario seleccionado para editar.');
        return;
    }

    if (!newUsername.trim() || !newDate.trim() || !newLimit.trim()) {
        alert('Los campos nombre, fecha y limite son obligatorios.');
        return;
    }

    try {
        const response = await apiFetch('/api/users/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentUser: currentEditingUser,
                user: newUsername.trim(),
                password: newPassword.trim(),
                date: newDate.trim(),
                limit: newLimit.trim()
            })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'No se pudo actualizar el usuario');
        }
        alert(data.message || 'Usuario actualizado');
        hideEditUserModal();
        fetchUsers();
    } catch (error) {
        alert(error.message || 'Error al actualizar usuario');
    }
}

function filterUsers() {
    const query = document.getElementById('user-search').value.toLowerCase();
    const filtered = allUsers.filter(u => 
        u.user.toLowerCase().includes(query) || 
        u.date.toLowerCase().includes(query)
    );
    renderUsers(filtered);
}

async function deleteUser(username) {
    if (!confirm(`¿Seguro que quieres eliminar a ${username}?`)) return;

    try {
        const response = await apiFetch('/api/users/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: username })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'No se pudo eliminar el usuario');
        }
        alert(data.message);
        fetchUsers();
    } catch (error) {
        alert(error.message || 'Error al eliminar usuario');
    }
}

function showAddUserModal() {
    document.getElementById('user-modal').classList.add('active');
}

function hideAddUserModal() {
    document.getElementById('user-modal').classList.remove('active');
    document.getElementById('new-username').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('new-date').value = '';
    document.getElementById('new-limit').value = '';
}

async function confirmAddUser() {
    const user = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const date = document.getElementById('new-date').value;
    const limit = document.getElementById('new-limit').value;

    if (!user || !date || !limit) {
        alert("Por favor completa todos los campos.");
        return;
    }

    try {
        const response = await apiFetch('/api/users/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user, password, date, limit })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'No se pudo agregar el usuario');
        }
        alert(data.message);
        hideAddUserModal();
        fetchUsers();
    } catch (error) {
        alert(error.message || 'Error al anadir usuario');
    }
}

// Initial session check
checkSession();

const loginInput = document.getElementById('admin-password');
if (loginInput) {
    loginInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') login();
    });
}

// Update status every 5 seconds
setInterval(() => {
    if (userToken) updateStatus();
}, 5000);
