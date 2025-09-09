/**
 * Komica Post Saver - Popup Script (改良版)
 *
 * 功能：
 * 1. 實現分頁切換 (已記憶 / 已隱藏 / NGID)。
 * 2. 載入並顯示對應列表的內容，並加入錯誤處理。
 * 3. 管理所有設定選項。
 * 4. 處理新增和刪除 NGID 的互動。
 * 5. 修正：點擊已更新的串時，會「強制重整」分頁並跳轉到第一則新回應。
 * 6. 安全性修正：避免使用 innerHTML 來插入動態內容。
 * 7. 新增：加入手動重載頁面功能的按鈕邏輯。
 */

document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    initializeSettings();
    loadSavedPosts();
    setupNgIdTab();
    setupReapplyButton(); // 新增：初始化手動重載按鈕
});

// --- 分頁管理 ---
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
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
            else if (button.id === 'tab-ngid') loadNgIds();
        });
    });
}

// --- 載入內容 ---

async function loadSavedPosts() {
    const container = document.getElementById('saved-posts-container');
    container.innerHTML = '<div class="loader">讀取中...</div>';
    try {
        const response = await browser.runtime.sendMessage({ action: 'getAllPosts' });
        container.innerHTML = '';
        if (response && response.success && response.data.length > 0) {
            response.data.forEach(post => container.appendChild(createSavedPostElement(post)));
        } else {
            container.innerHTML = '<div id="empty-message">尚未記憶任何貼文</div>';
        }
    } catch (e) {
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
            response.data.forEach(threadNo => container.appendChild(createHiddenThreadElement(threadNo)));
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
    const response = await browser.runtime.sendMessage({ action: 'getNgIds' });
    container.innerHTML = '';
    if (response && response.success && response.data.length > 0) {
        response.data.forEach(ngId => container.appendChild(createNgIdElement(ngId)));
    } else {
        container.innerHTML = '<div id="empty-message">沒有已封鎖的 ID</div>';
    }
}

// --- 建立 DOM 元素 ---

function createSavedPostElement(post) {
    const item = document.createElement('div');
    item.className = 'post-item';
    if (post.hasUpdate && post.newReplyCount > 0) {
        const indicator = document.createElement('div');
        indicator.className = 'update-indicator';
        indicator.textContent = `+${post.newReplyCount}`;
        indicator.title = `新增 ${post.newReplyCount} 則回應`;
        item.appendChild(indicator);
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
        let targetUrl;
        if (post.hasUpdate && post.firstNewReplyNo) {
            targetUrl = `${post.url.split('#')[0]}#r${post.firstNewReplyNo}`;
        } else {
            targetUrl = `${post.url.split('#')[0]}#r${post.postNo}`;
        }

        if (post.hasUpdate) {
            await browser.runtime.sendMessage({ action: 'clearUpdateFlag', postId: post.id });
        }
        
        const shouldOpenInNewTab = document.getElementById('open-in-new-tab-checkbox').checked;

        if (shouldOpenInNewTab) {
            const existingTabs = await browser.tabs.query({ url: `${post.url.split('#')[0]}*` });
            if (existingTabs.length > 0) {
                const reloadUrl = new URL(targetUrl);
                reloadUrl.searchParams.set('ks_reload', Date.now());
                const finalUrl = reloadUrl.href;

                browser.tabs.update(existingTabs[0].id, { active: true, url: finalUrl });
            } else {
                const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
                browser.tabs.create({ url: targetUrl, index: currentTab.index + 1 });
            }
        } else {
            const reloadUrl = new URL(targetUrl);
            reloadUrl.searchParams.set('ks_reload', Date.now());
            const finalUrl = reloadUrl.href;
            
            const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (currentTab) browser.tabs.update(currentTab.id, { url: finalUrl });
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

function createHiddenThreadElement(threadNo) {
    const item = document.createElement('div');
    item.className = 'hidden-item';
    const content = document.createElement('div');
    content.className = 'hidden-content';
    content.textContent = `No. ${threadNo}`;
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

function createNgIdElement(ngId) {
    const item = document.createElement('div');
    item.className = 'ngid-item';
    
    const ngIdSpan = document.createElement('span');
    ngIdSpan.className = 'ngid-text';
    ngIdSpan.textContent = ngId;
    item.appendChild(ngIdSpan);

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

// --- 設定管理 ---
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

// 新增：設定手動重載按鈕的功能
function setupReapplyButton() {
    const btn = document.getElementById('reapply-ng-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        // 尋找當前視窗中活躍的 Komica 分頁
        const tabs = await browser.tabs.query({ 
            active: true, 
            currentWindow: true,
            url: "*://*.komica1.org/*" 
        });

        if (tabs.length > 0) {
            const targetTab = tabs[0];
            // 發送訊息到 content_script
            browser.tabs.sendMessage(targetTab.id, { action: 'reapplyFunctions' });
            
            btn.textContent = '指令已傳送！';
            btn.disabled = true;
            setTimeout(() => window.close(), 500); // 延遲半秒後關閉 popup
        } else {
            btn.textContent = '找不到 Komica 分頁';
            btn.disabled = true;
        }
    });
}

async function initializeSettings() {
    const openInNewTabCheckbox = document.getElementById('open-in-new-tab-checkbox');
    const maxRecordsInput = document.getElementById('max-records-input');
    const autoCheckEnabledCheckbox = document.getElementById('auto-check-enabled');
    const checkIntervalInput = document.getElementById('check-interval-input');

    const settings = await browser.storage.local.get({
        openInNewTab: true, maxRecords: 50, autoCheckEnabled: false, checkInterval: 300
    });
    
    openInNewTabCheckbox.checked = settings.openInNewTab;
    openInNewTabCheckbox.addEventListener('change', () => {
        browser.storage.local.set({ openInNewTab: openInNewTabCheckbox.checked });
    });

    maxRecordsInput.value = settings.maxRecords;
    maxRecordsInput.addEventListener('change', async () => {
        let value = parseInt(maxRecordsInput.value, 10);
        if (isNaN(value) || value < 1) value = 1;
        maxRecordsInput.value = value;
        await browser.storage.local.set({ maxRecords: value });
        await browser.runtime.sendMessage({ action: 'trimRecords' });
        loadSavedPosts();
    });

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

    autoCheckEnabledCheckbox.addEventListener('change', handleAutoCheckSettingsChange);
    checkIntervalInput.addEventListener('change', handleAutoCheckSettingsChange);
}
