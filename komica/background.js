/**
 * Komica Post Saver - Background Script (v1.6.0 Fix)
 *
 * 變更：
 * 1. 新增自動清理過期「已隱藏」與「NGID」記錄的功能。
 * 2. 更新資料結構，為隱藏串和 NGID 加入時間戳。
 * 3. 新增相關的設定選項與每日執行的計時器。
 * 4. 加入資料移轉邏輯，兼容舊版使用者的資料。
 */

const CHECK_ALARM_NAME = 'komica-check-alarm';
const CLEANUP_ALARM_NAME = 'komica-cleanup-alarm';

// --- 初始化與啟動 ---
browser.runtime.onInstalled.addListener(() => {
    browser.storage.local.get(null, (data) => {
        const defaults = {
            savedPosts: [], hiddenThreads: [], ngIds: [],
            maxRecords: 50, autoCheckEnabled: false, checkInterval: 300,
            autoCleanupEnabled: true, cleanupDays: 30
        };
        const toSet = {};
        for (const key in defaults) {
            if (data[key] === undefined) toSet[key] = defaults[key];
        }
        if (Object.keys(toSet).length > 0) browser.storage.local.set(toSet);

        if (data.autoCheckEnabled) updateCheckAlarm();
        setupCleanupAlarm();
    });
});

browser.runtime.onStartup.addListener(() => {
    updateCheckAlarm();
    cleanupOldRecords();
    setupCleanupAlarm();
});

// --- 訊息監聽與路由 ---
browser.runtime.onMessage.addListener(async (message) => {
    switch (message.action) {
        case 'toggleSavePost': return await toggleSavePost(message.data);
        case 'getAllPosts': return await getAllPosts();
        case 'deletePost': return await deletePost(message.id);
        case 'isPostSaved': return await isPostSaved(message.postNo);
        case 'trimRecords': return await trimRecords();
        case 'updateAlarm': return await updateCheckAlarm();
        case 'clearUpdateFlag': return await clearUpdateFlag(message.postId);
        case 'hideThread': return await hideThread(message.threadNo);
        case 'unhideThread': return await unhideThread(message.threadNo);
        case 'getHiddenThreads': return await getHiddenThreads();
        case 'addNgId': return await addNgId(message.ngId);
        case 'removeNgId': return await removeNgId(message.ngId);
        case 'getNgIds': return await getNgIds();
        case 'runCleanup': return await cleanupOldRecords();
    }
    return true;
});

// --- 核心邏輯 ---
browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === CHECK_ALARM_NAME) {
        await checkPostUpdates();
    }
    if (alarm.name === CLEANUP_ALARM_NAME) {
        await cleanupOldRecords();
    }
});

async function checkPostUpdates() {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    if (!savedPosts || savedPosts.length === 0) return;
    let hasChanges = false;
    for (const post of savedPosts) {
        if (typeof post.initialReplyNo === 'undefined') continue;
        try {
            const response = await fetch(post.url);
            if (!response.ok) continue;
            const htmlText = await response.text();
            const { replyNos, threadPostNo } = parseThreadData(htmlText);
            if (!threadPostNo) continue;
            const newLastReplyNo = replyNos.length > 0 ? Math.max(...replyNos) : threadPostNo;
            if (newLastReplyNo > post.lastCheckedReplyNo) {
                const newRepliesSinceLastView = replyNos.filter(replyNo => replyNo > post.initialReplyNo);

                if (newRepliesSinceLastView.length > 0 && !post.hasUpdate) {
                    post.firstNewReplyNo = Math.min(...newRepliesSinceLastView);
                }

                post.lastCheckedReplyNo = newLastReplyNo;
                post.newReplyCount = newRepliesSinceLastView.length;
                post.hasUpdate = true;
                hasChanges = true;
            }
        } catch (error) { }
    }
    if (hasChanges) {
        await browser.storage.local.set({ savedPosts });
        await updateBadge();
    }
}

function parseThreadData(htmlText) {
    const replyNos = new Set();
    const replyPatterns = [
        /class="post reply"[^>]*data-no="(\d+)"/g,
        /data-no="(\d+)"[^>]*class="post reply"/g
    ];
    for (const pattern of replyPatterns) {
        for (const match of htmlText.matchAll(pattern)) {
            replyNos.add(parseInt(match[1], 10));
        }
    }

    const threadPatterns = [
        /class="post threadpost"[^>]*data-no="(\d+)"/,
        /data-no="(\d+)"[^>]*class="post threadpost"/
    ];
    let threadPostNo = null;
    for (const pattern of threadPatterns) {
        const match = htmlText.match(pattern);
        if (match) {
            threadPostNo = parseInt(match[1], 10);
            break;
        }
    }

    return { replyNos: Array.from(replyNos), threadPostNo };
}

async function cleanupOldRecords() {
    const {
        autoCleanupEnabled, cleanupDays,
        hiddenThreads: oldHiddenThreads, ngIds: oldNgIds
    } = await browser.storage.local.get({
        autoCleanupEnabled: true, cleanupDays: 30,
        hiddenThreads: [], ngIds: []
    });

    if (!autoCleanupEnabled) return { success: true, message: 'Auto-cleanup is disabled.' };

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - cleanupDays);

    const migrate = (item) => (typeof item === 'string') ? { id: item, addedAt: new Date().toISOString() } : item;

    const newHiddenThreads = oldHiddenThreads.map(migrate).filter(item => new Date(item.addedAt) > threshold);
    const newNgIds = oldNgIds.map(migrate).filter(item => new Date(item.addedAt) > threshold);

    await browser.storage.local.set({ hiddenThreads: newHiddenThreads, ngIds: newNgIds });

    console.log(`Komica Helper: Cleanup complete. Removed ${oldHiddenThreads.length - newHiddenThreads.length} hidden threads and ${oldNgIds.length - newNgIds.length} NGIDs.`);
    return { success: true };
}

// --- 資料操作函式 ---
async function hideThread(threadNo) {
    const { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    if (!hiddenThreads.some(item => (item.id || item) === threadNo)) {
        hiddenThreads.unshift({ id: threadNo, addedAt: new Date().toISOString() });
        await browser.storage.local.set({ hiddenThreads });
    }
    return { success: true };
}

async function unhideThread(threadNo) {
    let { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    const updatedThreads = hiddenThreads.filter(item => (item.id || item) !== threadNo);
    await browser.storage.local.set({ hiddenThreads: updatedThreads });
    notifyAllTabs({ action: 'unhideThread', threadNo });
    return { success: true };
}

async function addNgId(ngId) {
    if (!ngId || ngId.trim() === '') return { success: false, error: 'ID cannot be empty' };
    const { ngIds } = await browser.storage.local.get({ ngIds: [] });
    if (!ngIds.some(item => (item.id || item) === ngId)) {
        ngIds.unshift({ id: ngId, addedAt: new Date().toISOString() });
        await browser.storage.local.set({ ngIds });
        notifyAllTabs({ action: 'applyNgIdFilter' });
    }
    return { success: true };
}

async function removeNgId(ngId) {
    let { ngIds } = await browser.storage.local.get({ ngIds: [] });
    const updatedNgIds = ngIds.filter(item => (item.id || item) !== ngId);
    await browser.storage.local.set({ ngIds: updatedNgIds });
    notifyAllTabs({ action: 'unhidePostsByNgId', ngId: ngId });
    return { success: true };
}

async function getHiddenThreads() {
    const { hiddenThreads } = await browser.storage.local.get({ hiddenThreads: [] });
    const ids = hiddenThreads.map(item => item.id || item);
    return { success: true, data: ids };
}

async function getNgIds() {
    const { ngIds } = await browser.storage.local.get({ ngIds: [] });
    const ids = ngIds.map(item => item.id || item);
    return { success: true, data: ids };
}

async function updateCheckAlarm() {
    const { autoCheckEnabled, checkInterval } = await browser.storage.local.get({ autoCheckEnabled: false, checkInterval: 300 });
    await browser.alarms.clear(CHECK_ALARM_NAME);
    if (autoCheckEnabled) {
        const intervalInMinutes = Math.max(1, Math.round(checkInterval / 60));
        browser.alarms.create(CHECK_ALARM_NAME, { periodInMinutes: intervalInMinutes });
    }
}

async function setupCleanupAlarm() {
    await browser.alarms.clear(CLEANUP_ALARM_NAME);
    browser.alarms.create(CLEANUP_ALARM_NAME, { periodInMinutes: 60 * 24 });
}

// --- 其他未變更的函式 ---
async function toggleSavePost(postData) {
    const { savedPosts, maxRecords } = await browser.storage.local.get({ savedPosts: [], maxRecords: 50 });
    const existingIndex = savedPosts.findIndex(p => p.id === postData.id);
    if (existingIndex > -1) {
        savedPosts.splice(existingIndex, 1);
    } else {
        savedPosts.unshift(postData);
        if (savedPosts.length > maxRecords) {
            savedPosts.length = maxRecords;
        }
    }
    await browser.storage.local.set({ savedPosts });
    await updateBadge();
    return { success: true };
}

async function trimRecords() {
    const { savedPosts, maxRecords } = await browser.storage.local.get({ savedPosts: [], maxRecords: 50 });
    if (savedPosts.length > maxRecords) {
        savedPosts.length = maxRecords;
        await browser.storage.local.set({ savedPosts });
        await updateBadge();
    }
    return { success: true };
}

async function deletePost(postId) {
    let { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    savedPosts = savedPosts.filter(p => p.id !== postId);
    await browser.storage.local.set({ savedPosts });
    await updateBadge();
    return { success: true };
}

async function clearUpdateFlag(postId) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const post = savedPosts.find(p => p.id === postId);
    if (post && post.hasUpdate) {
        post.hasUpdate = false;
        post.newReplyCount = 0;
        post.initialReplyNo = post.lastCheckedReplyNo;
        post.firstNewReplyNo = null;
        await browser.storage.local.set({ savedPosts });
        await updateBadge();
    }
    return { success: true };
}

async function updateBadge() {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const totalNewReplies = savedPosts
        .filter(p => p.hasUpdate && p.newReplyCount > 0)
        .reduce((sum, p) => sum + p.newReplyCount, 0);

    if (totalNewReplies > 0) {
        browser.action.setBadgeText({ text: totalNewReplies.toString() });
        browser.action.setBadgeBackgroundColor({ color: '#d9534f' });
    } else {
        browser.action.setBadgeText({ text: '' });
    }
}

async function getAllPosts() {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    return { success: true, data: savedPosts };
}

async function isPostSaved(postNo) {
    const { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const isSaved = savedPosts.some(p => p.id === `post-${postNo}`);
    return { success: true, isSaved };
}

async function notifyAllTabs(message) {
    try {
        const tabs = await browser.tabs.query({ url: "*://*.komica1.org/*" });
        for (const tab of tabs) {
            try {
                await browser.tabs.sendMessage(tab.id, message);
            } catch (e) { }
        }
    } catch (e) { }
}

