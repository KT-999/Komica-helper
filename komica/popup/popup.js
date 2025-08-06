/**
 * Komica Post Saver - Popup Script
 *
 * 功能：
 * 1. 載入並套用所有使用者設定。
 * 2. 顯示貼文列表，並為有更新的貼文顯示新增的回應數量。
 * 3. 新增：在彈出視窗開啟時，清除附加元件圖示上的徽章。
 * 4. 點擊已更新的貼文後，清除其更新狀態，並將回應數基準重設。
 */

document.addEventListener('DOMContentLoaded', () => {
    // **新增：清除圖示徽章**
    browser.action.setBadgeText({ text: '' });

    loadPosts();
    initializeSettings();
});

const openInNewTabCheckbox = document.getElementById('open-in-new-tab-checkbox');
const maxRecordsInput = document.getElementById('max-records-input');
const autoCheckEnabledCheckbox = document.getElementById('auto-check-enabled');
const checkIntervalInput = document.getElementById('check-interval-input');

// 初始化所有設定
async function initializeSettings() {
    const settings = await browser.storage.local.get({
        openInNewTab: true,
        maxRecords: 50,
        autoCheckEnabled: false,
        checkInterval: 300
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
        loadPosts();
    });

    autoCheckEnabledCheckbox.checked = settings.autoCheckEnabled;
    checkIntervalInput.value = settings.checkInterval;
    checkIntervalInput.disabled = !settings.autoCheckEnabled;

    autoCheckEnabledCheckbox.addEventListener('change', handleAutoCheckSettingsChange);
    checkIntervalInput.addEventListener('change', handleAutoCheckSettingsChange);
}

// 處理自動更新設定的變更
function handleAutoCheckSettingsChange() {
    const enabled = autoCheckEnabledCheckbox.checked;
    let interval = parseInt(checkIntervalInput.value, 10);
    if (isNaN(interval) || interval < 60) {
        interval = 60;
        checkIntervalInput.value = interval;
    }
    checkIntervalInput.disabled = !enabled;
    browser.storage.local.set({ 
        autoCheckEnabled: enabled,
        checkInterval: interval 
    });
    browser.runtime.sendMessage({ action: 'updateAlarm' });
}

// 載入貼文
async function loadPosts() {
    const container = document.getElementById('posts-container');
    container.innerHTML = '<div class="loader"></div>';
    
    const response = await browser.runtime.sendMessage({ action: 'getAllPosts' });
    container.innerHTML = '';
    if (response.success && response.data.length > 0) {
        response.data.forEach(post => container.appendChild(createPostElement(post)));
    } else {
        container.innerHTML = '<div id="empty-message">尚未記憶任何貼文</div>';
    }
}

// 建立貼文元素
function createPostElement(post) {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.id = post.id;

    if (post.hasUpdate && post.newReplyCount > 0) {
        const indicator = document.createElement('div');
        indicator.className = 'update-indicator';
        indicator.textContent = `+${post.newReplyCount}`;
        indicator.title = `新增 ${post.newReplyCount} 則回應`;
        item.appendChild(indicator);
    }

    const content = document.createElement('div');
    content.className = 'post-content';
    
    const title = document.createElement('div');
    title.className = 'post-title';
    title.textContent = post.title;
    title.title = post.title;

    const preview = document.createElement('div');
    preview.className = 'post-preview';
    preview.textContent = post.preview;

    content.appendChild(title);
    content.appendChild(preview);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '刪除';
    deleteBtn.title = '刪除此筆紀錄';

    content.addEventListener('click', async () => {
        if (post.hasUpdate) {
            await browser.runtime.sendMessage({ action: 'clearUpdateFlag', postId: post.id });
        }
        
        const targetUrl = `${post.url}#r${post.postNo}`;
        const shouldOpenInNewTab = openInNewTabCheckbox.checked;

        if (shouldOpenInNewTab) {
            const existingTabs = await browser.tabs.query({ url: `${post.url.split('#')[0]}*` });
            if (existingTabs.length > 0) {
                browser.tabs.update(existingTabs[0].id, { active: true, url: targetUrl });
            } else {
                const currentTabs = await browser.tabs.query({ active: true, currentWindow: true });
                browser.tabs.create({ url: targetUrl, index: currentTabs[0].index + 1 });
            }
        } else {
            const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (currentTab) {
                browser.tabs.update(currentTab.id, { url: targetUrl });
            }
        }
        window.close();
    });

    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        item.style.opacity = '0.5';
        await browser.runtime.sendMessage({ action: 'deletePost', id: post.id });
        item.remove();
        if (document.querySelectorAll('.post-item').length === 0) {
            loadPosts();
        }
    });

    item.appendChild(content);
    item.appendChild(deleteBtn);
    return item;
}
