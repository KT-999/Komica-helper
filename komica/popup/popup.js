/**
 * Komica Post Saver - Popup Script
 *
 * 功能：
 * 1. DOM 載入後，向 background.js 請求所有已儲存的貼文。
 * 2. 載入並套用使用者設定（如：是否在新分頁開啟、最大記錄量）。
 * 3. 動態生成貼文列表並顯示在彈出視窗中。
 * 4. 為每個貼文項目添加點擊事件，並根據設定決定開啟方式。
 * 5. 為刪除按鈕添加點擊事件，以刪除該筆紀錄。
 * 6. 監聽設定變更並儲存。
 */

// DOM 載入後執行
document.addEventListener('DOMContentLoaded', () => {
    loadPosts();
    initializeSettings();
});

const openInNewTabCheckbox = document.getElementById('open-in-new-tab-checkbox');
const maxRecordsInput = document.getElementById('max-records-input');

// 初始化設定
async function initializeSettings() {
    // 從儲存空間讀取設定
    const settings = await browser.storage.local.get({
        openInNewTab: true, // 預設在新分頁開啟
        maxRecords: 50      // 預設最大記錄量為 50
    });
    
    // 設定 checkbox
    openInNewTabCheckbox.checked = settings.openInNewTab;
    openInNewTabCheckbox.addEventListener('change', () => {
        browser.storage.local.set({ openInNewTab: openInNewTabCheckbox.checked });
    });

    // 設定最大記錄量輸入框
    maxRecordsInput.value = settings.maxRecords;
    maxRecordsInput.addEventListener('change', () => {
        let value = parseInt(maxRecordsInput.value, 10);
        if (isNaN(value) || value < 1) {
            value = 1; // 最小值為 1
            maxRecordsInput.value = value;
        }
        browser.storage.local.set({ maxRecords: value });
    });
}

// 載入所有已儲存的貼文
async function loadPosts() {
    const container = document.getElementById('posts-container');
    container.innerHTML = '<div class="loader"></div>'; // 顯示讀取中
    
    try {
        const response = await browser.runtime.sendMessage({ action: 'getAllPosts' });
        container.innerHTML = ''; // 清空 loader

        if (response.success && response.data) {
            const posts = response.data;
            if (posts.length === 0) {
                container.innerHTML = '<div id="empty-message">尚未記憶任何貼文</div>';
                return;
            }

            posts.forEach(post => {
                const postElement = createPostElement(post);
                container.appendChild(postElement);
            });
        } else {
            throw new Error(response.error || '無法取得貼文');
        }
    } catch (error) {
        container.innerHTML = `<div id="empty-message">讀取錯誤: ${error.message}</div>`;
        console.error(error);
    }
}

// 建立單個貼文的 DOM 元素
function createPostElement(post) {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.id = post.id;

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

    // 點擊內容區域：跳轉到貼文
    content.addEventListener('click', async () => {
        const targetUrl = `${post.url}#r${post.postNo}`;
        const shouldOpenInNewTab = openInNewTabCheckbox.checked;

        if (shouldOpenInNewTab) {
            const existingTabs = await browser.tabs.query({ url: `${post.url.split('#')[0]}*` });
            if (existingTabs.length > 0) {
                browser.tabs.update(existingTabs[0].id, { active: true, url: targetUrl });
            } else {
                const currentTabs = await browser.tabs.query({ active: true, currentWindow: true });
                browser.tabs.create({
                    url: targetUrl,
                    index: currentTabs[0].index + 1
                });
            }
        } else {
            const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (currentTab) {
                browser.tabs.update(currentTab.id, { url: targetUrl });
            }
        }
        window.close();
    });

    // 點擊刪除按鈕
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
