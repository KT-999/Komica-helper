/**
 * Komica Post Saver - Background Script
 *
 * 功能：
 * 1. 監聽來自 content_script 和 popup 的訊息。
 * 2. 處理貼文的儲存、刪除、讀取請求。
 * 3. 儲存新貼文時，根據設定的最大數量自動修剪最舊的紀錄，並通知頁面更新。
 * 4. 刪除貼文後，主動通知所有 Komica 分頁更新 UI 狀態。
 * 5. 使用 browser.storage.local API 進行資料持久化。
 */

// 初始化儲存
browser.runtime.onInstalled.addListener(() => {
    browser.storage.local.get(['savedPosts', 'maxRecords'], (result) => {
        if (!result.savedPosts) {
            browser.storage.local.set({ savedPosts: [] });
        }
        if (!result.maxRecords) {
            browser.storage.local.set({ maxRecords: 50 }); // 預設值
        }
    });
});

// 監聽訊息
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    switch (message.action) {
        case 'toggleSavePost':
            return await toggleSavePost(message.data);
        case 'getAllPosts':
            return await getAllPosts();
        case 'deletePost':
            return await deletePost(message.id);
        case 'isPostSaved':
            return await isPostSaved(message.postNo);
    }
    return true; // 表示非同步處理
});

// 切換儲存/取消儲存貼文
async function toggleSavePost(postData) {
    try {
        const result = await browser.storage.local.get(['savedPosts', 'maxRecords']);
        let posts = result.savedPosts || [];
        const maxRecords = result.maxRecords || 50;

        const existingIndex = posts.findIndex(p => p.id === postData.id);

        if (existingIndex > -1) {
            // 如果已存在，則刪除 (取消儲存)
            posts.splice(existingIndex, 1);
        } else {
            // 如果是新貼文，直接加到陣列的最前面
            posts.unshift(postData);

            // **修正：檢查是否超出最大記錄量，如果超出則修剪並通知**
            if (posts.length > maxRecords) {
                // 找出將被移除的舊紀錄
                const postsToRemove = posts.slice(maxRecords);
                
                // 修剪陣列
                posts.length = maxRecords; 
                console.log(`[Komica Saver] 紀錄已修剪至上限 ${maxRecords} 筆。`);

                // 為每一筆被移除的紀錄發送更新通知
                for (const removedPost of postsToRemove) {
                    notifyTabsOfUpdate(removedPost.postNo, false);
                }
            }
        }

        await browser.storage.local.set({ savedPosts: posts });
        return { success: true, wasSaved: existingIndex === -1 };
    } catch (error) {
        console.error('Error toggling post save state:', error);
        return { success: false, error: error.message };
    }
}

// 取得所有已儲存的貼文
async function getAllPosts() {
    try {
        const result = await browser.storage.local.get({ savedPosts: [] });
        return { success: true, data: result.savedPosts };
    } catch (error) {
        console.error('Error getting posts:', error);
        return { success: false, error: error.message };
    }
}

// 刪除指定的貼文，並通知 content script
async function deletePost(postId) {
    try {
        const result = await browser.storage.local.get({ savedPosts: [] });
        let posts = result.savedPosts;
        
        const postToDelete = posts.find(p => p.id === postId);
        if (!postToDelete) return { success: false, error: 'Post not found' };

        posts = posts.filter(p => p.id !== postId);
        await browser.storage.local.set({ savedPosts: posts });

        // 通知分頁更新
        notifyTabsOfUpdate(postToDelete.postNo, false);
        console.log(`Post ${postId} deleted and all Komica tabs notified.`);
        return { success: true };
    } catch (error) {
        console.error('Error deleting post:', error);
        return { success: false, error: error.message };
    }
}

// 檢查特定貼文是否已儲存
async function isPostSaved(postNo) {
    try {
        const postId = `post-${postNo}`;
        const result = await browser.storage.local.get({ savedPosts: [] });
        const isSaved = result.savedPosts.some(p => p.id === postId);
        return { success: true, isSaved: isSaved };
    } catch (error) {
        console.error('Error checking if post is saved:', error);
        return { success: false, error: error.message };
    }
}

// **新增：一個共用的通知函式，用來更新所有 Komica 分頁的 UI**
async function notifyTabsOfUpdate(postNo, isSaved) {
    try {
        const tabs = await browser.tabs.query({ url: "https://gita.komica1.org/*" });
        for (const tab of tabs) {
            browser.tabs.sendMessage(tab.id, {
                action: 'updateButtonUI',
                postNo: postNo,
                isSaved: isSaved
            }).catch(e => console.log(`Could not send message to tab ${tab.id}, it might be closed or protected.`));
        }
    } catch (error) {
        console.error('Error notifying tabs:', error);
    }
}
