/**
 * Komica Post Saver - Background Script (Complete & Final Version)
 *
 * 功能：
 * 1. 管理「已記憶」、「已隱藏」、「NGID」三份列表。
 * 2. 管理偵測更新的 alarm。
 * 3. 處理所有與 content script 和 popup 之間的通訊。
 */

try {
  importScripts('browser-polyfill.js');
} catch (e) {
  console.error(e);
}

const ALARM_NAME = 'komica-check-alarm';

// --- 初始化與啟動 ---
browser.runtime.onInstalled.addListener(async () => {
    // 使用 await 等待 Promise 解析，這是更現代的寫法
    const data = await browser.storage.local.get(null);

    const defaults = {
        savedPosts: [],
        hiddenThreads: [],
        ngIds: [],
        maxRecords: 50,
        autoCheckEnabled: false,
        checkInterval: 300
    };
    const toSet = {};
    for (const key in defaults) {
        if (data[key] === undefined) {
            toSet[key] = defaults[key];
        }
    }
    if (Object.keys(toSet).length > 0) {
        await browser.storage.local.set(toSet);
    }
    if (data.autoCheckEnabled) {
        updateAlarm();
    }
});

browser.runtime.onStartup.addListener(updateAlarm);

// --- 訊息監聽與路由 ---
browser.runtime.onMessage.addListener(async (message) => {
    switch (message.action) {
        case 'toggleSavePost': return await toggleSavePost(message.data);
        case 'getAllPosts': return await getAllPosts();
        case 'deletePost': return await deletePost(message.id);
        case 'isPostSaved': return await isPostSaved(message.postNo);
        case 'trimRecords': return await trimRecords();
        case 'updateAlarm': return await updateAlarm();
        case 'clearUpdateFlag': return await clearUpdateFlag(message.postId);
        case 'hideThread': return await hideThread(message.threadNo);
        case 'unhideThread': return await unhideThread(message.threadNo);
        case 'getHiddenThreads': return await getHiddenThreads();
        case 'addNgId': return await addNgId(message.ngId);
        case 'removeNgId': return await removeNgId(message.ngId);
        case 'getNgIds': return await getNgIds();
    }
    return true;
});

// --- 核心偵測邏輯 ---
browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
        if (!savedPosts || savedPosts.length === 0) return;
        let hasChanges = false;
        const parser = new DOMParser();
        for (const post of savedPosts) {
            if (typeof post.initialReplyNo === 'undefined') continue;
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
                if (newLastReplyNo > post.lastCheckedReplyNo) {
                    const newRepliesSinceLastView = allReplies.filter(r => parseInt(r.dataset.no, 10) > post.initialReplyNo);
                    post.lastCheckedReplyNo = newLastReplyNo;
                    post.newReplyCount = newRepliesSinceLastView.length;
                    post.hasUpdate = true;
                    hasChanges = true;
                }
            } catch (error) {}
        }
        if (hasChanges) {
            await browser.storage.local.set({ savedPosts });
            browser.action.setBadgeText({ text: '!' });
            browser.action.setBadgeBackgroundColor({ color: '#d9534f' });
        }
    }
});

// --- 資料操作函式 ---

async function toggleSavePost(postData) {
    const { savedPosts, maxRecords } = await browser.storage.local.get({ savedPosts: [], maxRecords: 50 });
    const existingIndex = savedPosts.findIndex(p => p.id === postData.id);
    if (existingIndex > -1) {
        savedPosts.splice(existingIndex, 1);
    } else {
        savedPosts.unshift(postData);
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

async function clearUpdateFlag(postId) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const post = savedPosts.find(p => p.id === postId);
    if (post && post.hasUpdate) {
        post.hasUpdate = false;
        post.newReplyCount = 0;
        post.initialReplyNo = post.lastCheckedReplyNo;
        await browser.storage.local.set({ savedPosts });
        const remainingUpdates = savedPosts.some(p => p.hasUpdate);
        if (!remainingUpdates) {
            browser.action.setBadgeText({ text: '' });
        }
    }
    return { success: true };
}

async function hideThread(threadNo) {
    const { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    if (!hiddenThreads.includes(threadNo)) {
        hiddenThreads.unshift(threadNo);
        await browser.storage.local.set({ hiddenThreads });
    }
    return { success: true };
}

async function unhideThread(threadNo) {
    let { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    hiddenThreads = hiddenThreads.filter(no => no !== threadNo);
    await browser.storage.local.set({ hiddenThreads });
    notifyAllTabs({ action: 'unhideThread', threadNo });
    return { success: true };
}

async function addNgId(ngId) {
    if (!ngId || ngId.trim() === '') return { success: false, error: 'ID cannot be empty' };
    const { ngIds } = await browser.storage.local.get({ ngIds: [] });
    if (!ngIds.includes(ngId)) {
        ngIds.unshift(ngId);
        await browser.storage.local.set({ ngIds });
        notifyAllTabs({ action: 'applyNgIdFilter' });
    }
    return { success: true };
}

async function removeNgId(ngId) {
    let { ngIds } = await browser.storage.local.get({ ngIds: [] });
    ngIds = ngIds.filter(id => id !== ngId);
    await browser.storage.local.set({ ngIds });
    notifyAllTabs({ action: 'unhidePostsByNgId', ngId: ngId });
    return { success: true };
}

// --- 輔助函式 ---

async function updateAlarm() {
    const { autoCheckEnabled, checkInterval } = await browser.storage.local.get({ autoCheckEnabled: false, checkInterval: 300 });
    await browser.alarms.clear(ALARM_NAME);
    if (autoCheckEnabled) {
        const intervalInMinutes = Math.max(1, Math.round(checkInterval / 60));
        browser.alarms.create(ALARM_NAME, { periodInMinutes: intervalInMinutes });
    }
}

async function getAllPosts() {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    return { success: true, data: savedPosts };
}

async function getHiddenThreads() {
    const { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    return { success: true, data: hiddenThreads };
}

async function getNgIds() {
    const { ngIds } = await browser.storage.local.get({ ngIds: [] });
    return { success: true, data: ngIds };
}

async function isPostSaved(postNo) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const isSaved = savedPosts.some(p => p.id === `post-${postNo}`);
    return { success: true, isSaved };
}

async function notifyTabsOfUpdate(postNo, isSaved) {
    notifyAllTabs({ action: 'updateButtonUI', postNo, isSaved });
}

async function notifyAllTabs(message) {
    const tabs = await browser.tabs.query({ url: "https://gita.komica1.org/*" });
    for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, message).catch(e => {});
    }
}