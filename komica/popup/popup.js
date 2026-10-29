/**
 * Komica Post Saver - Popup Script (v1.7.0.0)
 *
 * 變更：
 * 1. 跨瀏覽器相容性 (Firefox / Chrome)。
 * 2. 支援過濾管理（ID 與 關鍵字 黑名單切換）。
 * 3. 支援失效/沉底貼文偵測、標記與一鍵清理。
 * 4. 支援設定管理：桌面通知、摺疊模式、以圖搜圖按鈕。
 * 5. 支援設定與記錄 JSON 匯出備份與匯入還原。
 */

if (typeof browser === 'undefined') {
    var browser = chrome;
}

document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupSubTabs();
    initializeSettings();
    loadSavedPosts();
    setupNgIdTab();
    setupKeywordTab();
    setupBackupHandlers();
    setupClearDeadButton();
    setupReapplyButton();
    setVersionInfo();
});

// --- 主分頁管理 ---
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tabs .tab-btn');
    const contentPanels = document.querySelectorAll('.content-panel');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const targetPanelId = button.dataset.target;
            contentPanels.forEach(panel => {
                panel.id === targetPanelId ? panel.classList.add('active') : panel.classList.remove('active');
            });

            if (button.id === 'tab-saved') loadSavedPosts();
            else if (button.id === 'tab-hidden') loadHiddenThreads();
            else if (button.id === 'tab-filter') {
                const activeSubtab = document.querySelector('.sub-tab-btn.active');
                if (activeSubtab && activeSubtab.id === 'subtab-keyword') {
                    loadKeywords();
                } else {
                    loadNgIds();
                }
            }
        });
    });
}

// --- 過濾管理子分頁 ---
function setupSubTabs() {
    const subTabButtons = document.querySelectorAll('.sub-tab-btn');
    const subPanels = document.querySelectorAll('.sub-panel');

    subTabButtons.forEach(button => {
        button.addEventListener('click', () => {
            subTabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const targetSubpanelId = button.dataset.subtarget;
            subPanels.forEach(panel => {
                panel.id === targetSubpanelId ? panel.classList.add('active') : panel.classList.remove('active');
            });

            if (button.id === 'subtab-ngid') loadNgIds();
            else if (button.id === 'subtab-keyword') loadKeywords();
        });
    });
}

// --- 載入內容 ---
async function loadSavedPosts() {
    const container = document.getElementById('saved-posts-container');
    const actionsBar = document.getElementById('saved-actions-bar');
    const deadCountSpan = document.getElementById('dead-count');
    container.innerHTML = '<div class="loader">讀取中...</div>';

    try {
        const response = await browser.runtime.sendMessage({ action: 'getAllPosts' });
        container.innerHTML = '';
        if (response && response.success && response.data.length > 0) {
            const deadPosts = response.data.filter(p => p.isDead);
            if (deadPosts.length > 0) {
                actionsBar.style.display = 'flex';
                deadCountSpan.textContent = deadPosts.length;
            } else {
                actionsBar.style.display = 'none';
            }

            response.data.forEach(post => container.appendChild(createSavedPostElement(post)));
        } else {
            actionsBar.style.display = 'none';
            container.innerHTML = '<div id="empty-message">尚未記憶任何貼文</div>';
        }
    } catch (e) {
        actionsBar.style.display = 'none';
        container.innerHTML = '<div id="empty-message">讀取紀錄時發生錯誤。</div>';
    }
}

async function loadHiddenThreads() {
    const container = document.getElementById('hidden-threads-container');
    container.innerHTML = '<div class="loader">讀取中...</div>';
    try {
        const response = await browser.runtime.sendMessage({ action: 'getHiddenThreads' });
        container.innerHTML = '';
        if (response && response.success && response.data.length > 0) {
            response.data.forEach(record => container.appendChild(createHiddenThreadElement(record)));
        } else {
            container.innerHTML = '<div id="empty-message">沒有已隱藏的串</div>';
        }
    } catch (e) {
        container.innerHTML = '<div id="empty-message">讀取紀錄時發生錯誤。</div>';
    }
}

async function loadNgIds() {
    const container = document.getElementById('ngid-list');
    container.innerHTML = '<div class="loader">讀取中...</div>';
    try {
        const response = await browser.runtime.sendMessage({ action: 'getNgIds' });
        container.innerHTML = '';
        if (response && response.success && response.data.length > 0) {
            response.data.forEach(record => container.appendChild(createNgIdElement(record)));
        } else {
            container.innerHTML = '<div id="empty-message">沒有已封鎖的 ID</div>';
        }
    } catch (e) {
        container.innerHTML = '<div id="empty-message">讀取紀錄時發生錯誤。</div>';
    }
}

async function loadKeywords() {
    const container = document.getElementById('keyword-list');
    container.innerHTML = '<div class="loader">讀取中...</div>';
    try {
        const response = await browser.runtime.sendMessage({ action: 'getNgKeywords' });
        container.innerHTML = '';
        if (response && response.success && response.data.length > 0) {
            response.data.forEach(record => container.appendChild(createKeywordElement(record)));
        } else {
            container.innerHTML = '<div id="empty-message">沒有已封鎖的關鍵字</div>';
        }
    } catch (e) {
        container.innerHTML = '<div id="empty-message">讀取紀錄時發生錯誤。</div>';
    }
}

// --- 建立 DOM 元素 ---
function createSavedPostElement(post) {
    const item = document.createElement('div');
    item.className = 'post-item';
    if (post.isDead) {
        item.classList.add('is-dead');
    }

    if (post.hasUpdate && post.newReplyCount > 0 && !post.isDead) {
        const indicator = document.createElement('div');
        indicator.className = 'update-indicator';
        indicator.textContent = `+${post.newReplyCount}`;
        indicator.title = `新增 ${post.newReplyCount} 則回應`;
        item.appendChild(indicator);
    } else if (post.isDead) {
        const deadIndicator = document.createElement('div');
        deadIndicator.className = 'dead-indicator';
        deadIndicator.textContent = '已沉底';
        deadIndicator.title = '討論串可能已沉底或被刪除 (404)';
        item.appendChild(deadIndicator);
    }
    
    const content = document.createElement('div');
    content.className = 'post-content';
    
    const titleDiv = document.createElement('div');
    titleDiv.className = 'post-title';
    titleDiv.title = post.title;
    titleDiv.textContent = post.title;

    const previewDiv = document.createElement('div');
    previewDiv.className = 'post-preview';
    previewDiv.textContent = post.preview;

    content.appendChild(titleDiv);
    content.appendChild(previewDiv);
    
    content.addEventListener('click', async () => {
        const { openInNewTab } = await browser.storage.local.get({ openInNewTab: true });
        let targetUrl;
        if (post.hasUpdate && post.firstNewReplyNo) {
            targetUrl = `${post.url.split('#')[0]}#r${post.firstNewReplyNo}`;
        } else {
            targetUrl = `${post.url.split('#')[0]}#r${post.postNo}`;
        }

        if (post.hasUpdate) {
            await browser.runtime.sendMessage({ action: 'clearUpdateFlag', postId: post.id });
        }
        
        const baseUrl = post.url.split('#')[0];
        const existingTabs = await browser.tabs.query({ url: `${baseUrl}*` });
        const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });

        if (existingTabs.length > 0) {
            const reloadUrl = new URL(targetUrl);
            reloadUrl.searchParams.set('_ktr', Date.now());
            const finalUrl = reloadUrl.href;
            browser.tabs.update(existingTabs[0].id, { active: true, url: finalUrl });
        } else if (openInNewTab) {
            browser.tabs.create({
                url: targetUrl,
                index: currentTab ? currentTab.index + 1 : undefined
            });
        } else if (currentTab) {
            browser.tabs.update(currentTab.id, { url: targetUrl });
        }
        window.close();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.textContent = '刪除';
    deleteBtn.addEventListener('click', async () => {
        item.style.opacity = '0.5';
        await browser.runtime.sendMessage({ action: 'deletePost', id: post.id });
        item.remove();
        if (document.querySelectorAll('#saved-posts-container .post-item').length === 0) {
            loadSavedPosts();
        }
    });

    item.appendChild(content);
    item.appendChild(deleteBtn);
    return item;
}

function createHiddenThreadElement(record) {
    const threadNo = record.id || record;
    const item = document.createElement('div');
    item.className = 'hidden-item';
    const content = document.createElement('div');
    content.className = 'hidden-content';

    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = `No. ${threadNo}`;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatTimestamp(record.addedAt);

    content.appendChild(title);
    content.appendChild(meta);
    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'action-btn unhide-btn';
    unhideBtn.textContent = '解除隱藏';
    unhideBtn.addEventListener('click', async () => {
        item.style.opacity = '0.5';
        await browser.runtime.sendMessage({ action: 'unhideThread', threadNo: threadNo });
        item.remove();
        if (document.querySelectorAll('#hidden-threads-container .hidden-item').length === 0) {
            loadHiddenThreads();
        }
    });
    item.appendChild(content);
    item.appendChild(unhideBtn);
    return item;
}

function createNgIdElement(record) {
    const ngId = record.id || record;
    const item = document.createElement('div');
    item.className = 'ngid-item';
    
    const content = document.createElement('div');
    content.className = 'ngid-content';

    const ngIdSpan = document.createElement('div');
    ngIdSpan.className = 'ngid-text';
    ngIdSpan.textContent = ngId;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatTimestamp(record.addedAt);

    content.appendChild(ngIdSpan);
    content.appendChild(meta);
    item.appendChild(content);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn delete-btn';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', async () => {
        item.style.opacity = '0.5';
        await browser.runtime.sendMessage({ action: 'removeNgId', ngId: ngId });
        item.remove();
        if (document.querySelectorAll('#ngid-list .ngid-item').length === 0) {
            loadNgIds();
        }
    });
    item.appendChild(removeBtn);
    return item;
}

function createKeywordElement(record) {
    const keyword = record.keyword || record;
    const item = document.createElement('div');
    item.className = 'ngid-item';
    
    const content = document.createElement('div');
    content.className = 'ngid-content';

    const kwSpan = document.createElement('div');
    kwSpan.className = 'ngid-text';
    kwSpan.textContent = keyword;

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatTimestamp(record.addedAt);

    content.appendChild(kwSpan);
    content.appendChild(meta);
    item.appendChild(content);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn delete-btn';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', async () => {
        item.style.opacity = '0.5';
        await browser.runtime.sendMessage({ action: 'removeNgKeyword', keyword: keyword });
        item.remove();
        if (document.querySelectorAll('#keyword-list .ngid-item').length === 0) {
            loadKeywords();
        }
    });
    item.appendChild(removeBtn);
    return item;
}

function formatTimestamp(value) {
    if (!value) return '加入時間：未知';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '加入時間：未知';
    const formatted = date.toLocaleString('zh-TW', { hour12: false });
    return `加入時間：${formatted}`;
}

// --- 清理失效貼文按鈕 ---
function setupClearDeadButton() {
    const btn = document.getElementById('clear-dead-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (!confirm('確定要清理所有已失效/沉底的貼文嗎？')) return;
        btn.disabled = true;
        btn.textContent = '清理中...';
        await browser.runtime.sendMessage({ action: 'clearDeadPosts' });
        await loadSavedPosts();
        btn.disabled = false;
    });
}

// --- 過濾設定綁定 ---
function setupNgIdTab() {
    const input = document.getElementById('ngid-input');
    const addButton = document.getElementById('add-ngid-btn');
    const addId = async () => {
        const idToAdd = input.value.trim();
        if (idToAdd) {
            await browser.runtime.sendMessage({ action: 'addNgId', ngId: idToAdd });
            input.value = '';
            loadNgIds();
        }
    };
    addButton.addEventListener('click', addId);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addId();
    });
}

function setupKeywordTab() {
    const input = document.getElementById('keyword-input');
    const addButton = document.getElementById('add-keyword-btn');
    const addKw = async () => {
        const kwToAdd = input.value.trim();
        if (kwToAdd) {
            await browser.runtime.sendMessage({ action: 'addNgKeyword', keyword: kwToAdd });
            input.value = '';
            loadKeywords();
        }
    };
    addButton.addEventListener('click', addKw);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addKw();
    });
}

// --- 備份與還原 ---
function setupBackupHandlers() {
    const exportBtn = document.getElementById('export-backup-btn');
    const importBtn = document.getElementById('import-backup-btn');
    const fileInput = document.getElementById('import-file-input');
    const statusMsg = document.getElementById('import-status');

    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            const res = await browser.runtime.sendMessage({ action: 'exportData' });
            if (res && res.success) {
                const jsonStr = JSON.stringify(res.data, null, 2);
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const dateStr = new Date().toISOString().slice(0, 10);
                const a = document.createElement('a');
                a.href = url;
                a.download = `komica-helper-backup-${dateStr}.json`;
                a.click();
                URL.revokeObjectURL(url);
                statusMsg.textContent = '備份檔已匯出下載！';
                statusMsg.style.color = '#28a745';
                setTimeout(() => { statusMsg.textContent = ''; }, 3000);
            }
        });
    }

    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    if (!parsed || typeof parsed !== 'object') throw new Error('檔案格式錯誤');

                    const overwrite = confirm('要「覆蓋」現有記錄嗎？\n[確定]：完全覆蓋現有資料\n[取消]：與現有資料進行合併');
                    const mode = overwrite ? 'overwrite' : 'merge';

                    const res = await browser.runtime.sendMessage({
                        action: 'importData',
                        payload: { data: parsed, mode }
                    });

                    if (res && res.success) {
                        statusMsg.textContent = `匯入成功 (${overwrite ? '已覆蓋' : '已合併'})！`;
                        statusMsg.style.color = '#28a745';
                        initializeSettings();
                        loadSavedPosts();
                    } else {
                        statusMsg.textContent = `匯入失敗：${res.error || '未知錯誤'}`;
                        statusMsg.style.color = '#d9534f';
                    }
                } catch (err) {
                    statusMsg.textContent = 'JSON 解析失敗，請確認檔案內容格式！';
                    statusMsg.style.color = '#d9534f';
                }
                fileInput.value = '';
                setTimeout(() => { statusMsg.textContent = ''; }, 4000);
            };
            reader.readAsText(file);
        });
    }
}

// --- 手動重載按鈕 ---
function setupReapplyButton() {
    const btn = document.getElementById('reapply-functions-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        const patterns = [
            "*://*.komica1.org/*",
            "*://*.komica.org/*",
            "*://*.komica2.net/*",
            "*://*.2cat.org/*"
        ];
        let targetTab = null;
        for (const pattern of patterns) {
            try {
                const tabs = await browser.tabs.query({ 
                    active: true, 
                    currentWindow: true,
                    url: pattern 
                });
                if (tabs.length > 0) {
                    targetTab = tabs[0];
                    break;
                }
            } catch (e) { }
        }

        if (targetTab) {
            try {
                await browser.tabs.sendMessage(targetTab.id, { action: 'reapplyFunctions' });
                btn.textContent = '指令已傳送！';
            } catch (e) {
                btn.textContent = '傳送失敗，請重整頁面';
            }
        } else {
            btn.textContent = '找不到 Komica 分頁';
        }
        btn.disabled = true;
        setTimeout(() => window.close(), 1000);
    });
}

function setVersionInfo() {
    const versionElement = document.getElementById('app-version');
    if (!versionElement) return;
    const manifest = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getManifest)
        ? browser.runtime.getManifest()
        : null;
    versionElement.textContent = manifest && manifest.version ? manifest.version : '未知';
}

// --- 設定初始化與監聽 ---
async function initializeSettings() {
    const openInNewTabCheckbox = document.getElementById('open-in-new-tab-checkbox');
    const collapseModeCheckbox = document.getElementById('collapse-mode-checkbox');
    const imageSearchCheckbox = document.getElementById('image-search-checkbox');
    const notificationsCheckbox = document.getElementById('notifications-enabled');
    const maxRecordsInput = document.getElementById('max-records-input');
    const autoCheckEnabledCheckbox = document.getElementById('auto-check-enabled');
    const checkIntervalInput = document.getElementById('check-interval-input');
    const autoCleanupEnabledCheckbox = document.getElementById('auto-cleanup-enabled');
    const cleanupDaysInput = document.getElementById('cleanup-days-input');

    const settings = await browser.storage.local.get({
        openInNewTab: true,
        collapseMode: false,
        enableImageSearch: true,
        enableNotifications: false,
        maxRecords: 50,
        autoCheckEnabled: false,
        checkInterval: 300,
        autoCleanupEnabled: true,
        cleanupDays: 30
    });
    
    openInNewTabCheckbox.checked = settings.openInNewTab;
    openInNewTabCheckbox.onchange = () => {
        browser.storage.local.set({ openInNewTab: openInNewTabCheckbox.checked });
    };

    collapseModeCheckbox.checked = settings.collapseMode;
    collapseModeCheckbox.onchange = () => {
        browser.storage.local.set({ collapseMode: collapseModeCheckbox.checked });
    };

    imageSearchCheckbox.checked = settings.enableImageSearch;
    imageSearchCheckbox.onchange = () => {
        browser.storage.local.set({ enableImageSearch: imageSearchCheckbox.checked });
    };

    notificationsCheckbox.checked = settings.enableNotifications;
    notificationsCheckbox.onchange = () => {
        browser.storage.local.set({ enableNotifications: notificationsCheckbox.checked });
    };

    maxRecordsInput.value = settings.maxRecords;
    maxRecordsInput.onchange = async () => {
        let value = parseInt(maxRecordsInput.value, 10);
        if (isNaN(value) || value < 1) value = 1;
        maxRecordsInput.value = value;
        await browser.storage.local.set({ maxRecords: value });
        await browser.runtime.sendMessage({ action: 'trimRecords' });
        loadSavedPosts();
    };

    autoCheckEnabledCheckbox.checked = settings.autoCheckEnabled;
    checkIntervalInput.value = settings.checkInterval;
    checkIntervalInput.disabled = !settings.autoCheckEnabled;

    const handleAutoCheckSettingsChange = () => {
        const enabled = autoCheckEnabledCheckbox.checked;
        let interval = parseInt(checkIntervalInput.value, 10);
        if (isNaN(interval) || interval < 60) {
            interval = 60;
            checkIntervalInput.value = interval;
        }
        checkIntervalInput.disabled = !enabled;
        browser.storage.local.set({ autoCheckEnabled: enabled, checkInterval: interval });
        browser.runtime.sendMessage({ action: 'updateAlarm' });
    };

    autoCheckEnabledCheckbox.onchange = handleAutoCheckSettingsChange;
    checkIntervalInput.onchange = handleAutoCheckSettingsChange;

    autoCleanupEnabledCheckbox.checked = settings.autoCleanupEnabled;
    cleanupDaysInput.value = settings.cleanupDays;
    cleanupDaysInput.disabled = !settings.autoCleanupEnabled;

    const handleCleanupSettingsChange = () => {
        const enabled = autoCleanupEnabledCheckbox.checked;
        let days = parseInt(cleanupDaysInput.value, 10);
        if (isNaN(days) || days < 1) {
            days = 1;
            cleanupDaysInput.value = days;
        }
        cleanupDaysInput.disabled = !enabled;
        browser.storage.local.set({ autoCleanupEnabled: enabled, cleanupDays: days });
        browser.runtime.sendMessage({ action: 'runCleanup' });
    };

    autoCleanupEnabledCheckbox.onchange = handleCleanupSettingsChange;
    cleanupDaysInput.onchange = handleCleanupSettingsChange;
}
