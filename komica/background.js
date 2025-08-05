/**
 * Komica Post Saver - Background Script
 *
 * 功能：
 * 1. 監聽來自 content_script 和 popup 的訊息。
 * 2. 處理貼文的儲存、刪除、讀取請求。
 * 3. 使用 browser.storage.local API 進行資料持久化。
 */

// 初始化儲存
browser.runtime.onInstalled.addListener(() => {
    browser.storage.local.get('savedPosts', (result) => {
        if (!result.savedPosts) {
            browser.storage.local.set({ savedPosts: [] });
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
        const result = await browser.storage.local.get({ savedPosts: [] });
        const posts = result.savedPosts;
        const existingIndex = posts.findIndex(p => p.id === postData.id);

        if (existingIndex > -1) {
            // 如果已存在，則刪除（取消儲存）
            posts.splice(existingIndex, 1);
        } else {
            // 如果不存在，則新增
            posts.push(postData);
            // 讓最新的在最上面
            posts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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

// 刪除指定的貼文
async function deletePost(postId) {
    try {
        const result = await browser.storage.local.get({ savedPosts: [] });
        let posts = result.savedPosts;
        posts = posts.filter(p => p.id !== postId);
        await browser.storage.local.set({ savedPosts: posts });
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
