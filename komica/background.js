/**
 * Komica Post Saver - Background Script (Cleaned Version)
 *
 * 功能：
 * 1. 管理所有資料的儲存、讀取、刪除、修剪。
 * 2. 管理一個定期的偵測任務 (alarm)，用來檢查貼文更新。
 * 3. 執行偵測任務：抓取頁面、解析、並以「最後回應編號」為基準進行比較。
 * 4. 在有更新時，於附加元件圖示上顯示「!」徽章。
 * 5. 處理所有與 content script 和 popup 之間的通訊，確保狀態同步。
 */

const ALARM_NAME = 'komica-check-alarm';

// --- 初始化與啟動 ---

// 附加元件安裝或更新時，初始化儲存設定
browser.runtime.onInstalled.addListener(() => {
    browser.storage.local.get(['savedPosts', 'maxRecords', 'autoCheckEnabled', 'checkInterval'], (result) => {
        if (!result.savedPosts) browser.storage.local.set({ savedPosts: [] });
        if (!result.maxRecords) browser.storage.local.set({ maxRecords: 50 });
        if (result.autoCheckEnabled === undefined) browser.storage.local.set({ autoCheckEnabled: false });
        if (!result.checkInterval) browser.storage.local.set({ checkInterval: 300 });
        if (result.autoCheckEnabled) updateAlarm();
    });
});

// 瀏覽器啟動時，根據儲存的設定重新啟用偵測任務
browser.runtime.onStartup.addListener(updateAlarm);

// --- 訊息監聽與路由 ---

// 監聽來自 popup 和 content script 的所有訊息
browser.runtime.onMessage.addListener(async (message) => {
    switch (message.action) {
        case 'toggleSavePost': return await toggleSavePost(message.data);
        case 'getAllPosts': return await getAllPosts();
        case 'deletePost': return await deletePost(message.id);
        case 'isPostSaved': return await isPostSaved(message.postNo);
        case 'trimRecords': return await trimRecords();
        case 'updateAlarm': return await updateAlarm();
        case 'clearUpdateFlag': return await clearUpdateFlag(message.postId);
    }
    return true;
});

// --- 核心偵測邏輯 ---

// 偵測任務觸發時執行的函式
browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        console.log('[Komica Saver] 開始執行更新檢查...');
        const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
        if (!savedPosts || savedPosts.length === 0) return;

        let hasChanges = false;
        const parser = new DOMParser();

        for (const post of savedPosts) {
            // 檢查是否為新格式資料，如果不是則跳過
            if (typeof post.initialReplyNo === 'undefined' || typeof post.lastCheckedReplyNo === 'undefined') {
                continue;
            }

            try {
                const response = await fetch(post.url);
                if (!response.ok) continue;
                
                const htmlText = await response.text();
                const doc = parser.parseFromString(htmlText, 'text/html');
                
                const allReplies = Array.from(doc.querySelectorAll('.post.reply'));
                const opPost = doc.querySelector('.post.threadpost');
                if (!opPost) continue;

                const lastPostOnPage = allReplies.length > 0 ? allReplies[allReplies.length - 1] : opPost;
                const newLastReplyNo = parseInt(lastPostOnPage.dataset.no, 10);

                // 以「最後檢查的回應編號」為基準進行比較
                if (newLastReplyNo > post.lastCheckedReplyNo) {
                    // 以「使用者上次查看的編號」為基準計算新增數量
                    const newRepliesSinceLastView = allReplies.filter(r => parseInt(r.dataset.no, 10) > post.initialReplyNo);
                    
                    post.lastCheckedReplyNo = newLastReplyNo;
                    post.newReplyCount = newRepliesSinceLastView.length;
                    post.hasUpdate = true;
                    hasChanges = true;
                }
            } catch (error) {
                console.error(`[Komica Saver] 檢查 No.${post.postNo} 時發生錯誤:`, error);
            }
        }

        if (hasChanges) {
            await browser.storage.local.set({ savedPosts: savedPosts });
            browser.action.setBadgeText({ text: '!' });
            browser.action.setBadgeBackgroundColor({ color: '#d9534f' });
        }
    }
});

// --- 資料操作函式 ---

// 儲存或取消儲存一則貼文
async function toggleSavePost(postData) {
    const { savedPosts, maxRecords } = await browser.storage.local.get({ savedPosts: [], maxRecords: 50 });
    const existingIndex = savedPosts.findIndex(p => p.id === postData.id);

    if (existingIndex > -1) {
        savedPosts.splice(existingIndex, 1); // 取消儲存
    } else {
        savedPosts.unshift(postData); // 新增至最前面
        // 檢查是否超出上限
        if (savedPosts.length > maxRecords) {
            const postsToRemove = savedPosts.slice(maxRecords);
            savedPosts.length = maxRecords;
            for (const removedPost of postsToRemove) {
                notifyTabsOfUpdate(removedPost.postNo, false);
            }
        }
    }
    await browser.storage.local.set({ savedPosts });
    return { success: true };
}

// 根據使用者設定即時修剪紀錄
async function trimRecords() {
    const { savedPosts, maxRecords } = await browser.storage.local.get({ savedPosts: [], maxRecords: 50 });
    if (savedPosts.length > maxRecords) {
        const postsToRemove = savedPosts.slice(maxRecords);
        savedPosts.length = maxRecords;
        await browser.storage.local.set({ savedPosts });
        for (const removedPost of postsToRemove) {
            notifyTabsOfUpdate(removedPost.postNo, false);
        }
    }
    return { success: true };
}

// 手動刪除一則貼文
async function deletePost(postId) {
    let { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const postToDelete = savedPosts.find(p => p.id === postId);
    if (postToDelete) {
        savedPosts = savedPosts.filter(p => p.id !== postId);
        await browser.storage.local.set({ savedPosts });
        notifyTabsOfUpdate(postToDelete.postNo, false);
    }
    return { success: true };
}

// 清除更新旗標 (當使用者查看後)
async function clearUpdateFlag(postId) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const post = savedPosts.find(p => p.id === postId);
    if (post && post.hasUpdate) {
        post.hasUpdate = false;
        post.newReplyCount = 0;
        post.initialReplyNo = post.lastCheckedReplyNo; // 重設基準點
        await browser.storage.local.set({ savedPosts });

        // 檢查是否所有更新都已被查看，以決定是否清除圖示徽章
        const remainingUpdates = savedPosts.some(p => p.hasUpdate);
        if (!remainingUpdates) {
            browser.action.setBadgeText({ text: '' });
        }
    }
    return { success: true };
}

// --- 輔助函式 ---

// 更新或建立偵測任務
async function updateAlarm() {
    const { autoCheckEnabled, checkInterval } = await browser.storage.local.get({ autoCheckEnabled: false, checkInterval: 300 });
    await browser.alarms.clear(ALARM_NAME);
    if (autoCheckEnabled) {
        const intervalInMinutes = Math.max(1, Math.round(checkInterval / 60));
        browser.alarms.create(ALARM_NAME, { periodInMinutes: intervalInMinutes });
    }
}

// 取得所有貼文
async function getAllPosts() {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    return { success: true, data: savedPosts };
}

// 檢查特定貼文是否已儲存
async function isPostSaved(postNo) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const isSaved = savedPosts.some(p => p.id === `post-${postNo}`);
    return { success: true, isSaved };
}

// 共用的通知函式，用來更新所有 Komica 分頁的 UI
async function notifyTabsOfUpdate(postNo, isSaved) {
    const tabs = await browser.tabs.query({ url: "https://gita.komica1.org/*" });
    for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, {
            action: 'updateButtonUI',
            postNo: postNo,
            isSaved: isSaved
        }).catch(e => {}); // 忽略錯誤，因為分頁可能已關閉
    }
}
