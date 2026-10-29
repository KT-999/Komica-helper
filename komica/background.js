/**
 * Komica Post Saver - Background Script (v1.7.0.0)
 *
 * 變更：
 * 1. 跨瀏覽器相容性 (Firefox / Chrome)。
 * 2. 擴展支援網域 (komica1.org, komica.org, komica2.net, 2cat.org)。
 * 3. 強化貼文更新檢查的回應與討論串主樓解析邏輯。
 * 4. 新增：已失效 / 沉底 (404) 討論串偵測與清理。
 * 5. 新增：桌面推播通知支援 (可於設定中啟用)。
 * 6. 新增：NG 關鍵字過濾管理。
 * 7. 新增：設定與記錄 JSON 匯出/匯入。
 * 8. 自動清理過期「已隱藏」、「NGID」與「NG關鍵字」記錄。
 */

if (typeof browser === 'undefined') {
    var browser = chrome;
}

const CHECK_ALARM_NAME = 'komica-check-alarm';
const CLEANUP_ALARM_NAME = 'komica-cleanup-alarm';

// --- 初始化與啟動 ---
browser.runtime.onInstalled.addListener(() => {
    browser.storage.local.get(null, (data) => {
        const defaults = {
            savedPosts: [], hiddenThreads: [], ngIds: [], ngKeywords: [],
            maxRecords: 50, autoCheckEnabled: false, checkInterval: 300,
            autoCleanupEnabled: true, cleanupDays: 30,
            openInNewTab: true, collapseMode: false,
            enableNotifications: false, enableImageSearch: true
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
        case 'clearDeadPosts': return await clearDeadPosts();
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
        case 'addNgKeyword': return await addNgKeyword(message.keyword);
        case 'removeNgKeyword': return await removeNgKeyword(message.keyword);
        case 'getNgKeywords': return await getNgKeywords();
        case 'exportData': return await exportData();
        case 'importData': return await importData(message.payload);
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

// --- 通知點擊跳轉 ---
if (browser.notifications && browser.notifications.onClicked) {
    browser.notifications.onClicked.addListener(async (notificationId) => {
        if (!notificationId.startsWith('komica-post-')) return;
        const postId = notificationId.replace('komica-post-', '');
        const { savedPosts, openInNewTab } = await browser.storage.local.get({ savedPosts: [], openInNewTab: true });
        const post = savedPosts.find(p => p.id === postId);
        if (!post) return;

        let targetUrl = post.url;
        if (post.firstNewReplyNo) {
            targetUrl = `${post.url.split('#')[0]}#r${post.firstNewReplyNo}`;
        }
        await clearUpdateFlag(postId);

        if (openInNewTab) {
            browser.tabs.create({ url: targetUrl });
        } else {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                browser.tabs.update(tabs[0].id, { url: targetUrl });
            } else {
                browser.tabs.create({ url: targetUrl });
            }
        }
    });
}

async function checkPostUpdates() {
    const { savedPosts, enableNotifications } = await browser.storage.local.get({ savedPosts: [], enableNotifications: false });
    if (!savedPosts || savedPosts.length === 0) return;
    let hasChanges = false;

    for (const post of savedPosts) {
        if (typeof post.initialReplyNo === 'undefined') continue;
        try {
            const response = await fetch(post.url);
            // 404 / 410 表示討論串已失效或沉底
            if (response.status === 404 || response.status === 410) {
                if (!post.isDead) {
                    post.isDead = true;
                    post.deadAt = new Date().toISOString();
                    hasChanges = true;
                }
                continue;
            }
            if (!response.ok) continue;

            const htmlText = await response.text();
            // 檢查 Pixmicat 錯誤頁面（串已被刪除或找不到）
            if (htmlText.includes('找不到此貼文') || htmlText.includes('貼文不存在') || htmlText.includes('該討論串已被刪除')) {
                if (!post.isDead) {
                    post.isDead = true;
                    post.deadAt = new Date().toISOString();
                    hasChanges = true;
                }
                continue;
            }

            if (post.isDead) {
                post.isDead = false;
                delete post.deadAt;
                hasChanges = true;
            }

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

                // 桌面推播通知
                if (enableNotifications && browser.notifications && newRepliesSinceLastView.length > 0) {
                    try {
                        browser.notifications.create(`komica-post-${post.id}`, {
                            type: 'basic',
                            iconUrl: 'icons/icon-96.png',
                            title: 'Komica 討論串有新回應！',
                            message: `「${post.title}」新增了 ${newRepliesSinceLastView.length} 則回應`
                        });
                    } catch (e) { }
                }
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
        /data-no="(\d+)"[^>]*class="post reply"/g,
        /<div[^>]*class="[^"]*\breply\b[^"]*"[^>]*data-no="(\d+)"/g,
        /<div[^>]*data-no="(\d+)"[^>]*class="[^"]*\breply\b[^"]*"/g
    ];
    for (const pattern of replyPatterns) {
        for (const match of htmlText.matchAll(pattern)) {
            replyNos.add(parseInt(match[1], 10));
        }
    }

    const threadPatterns = [
        /class="post threadpost"[^>]*data-no="(\d+)"/,
        /data-no="(\d+)"[^>]*class="post threadpost"/,
        /<div[^>]*class="[^"]*\bthreadpost\b[^"]*"[^>]*data-no="(\d+)"/,
        /<div[^>]*data-no="(\d+)"[^>]*class="[^"]*\bthreadpost\b[^"]*"/
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
        hiddenThreads: oldHiddenThreads, ngIds: oldNgIds, ngKeywords: oldNgKeywords
    } = await browser.storage.local.get({
        autoCleanupEnabled: true, cleanupDays: 30,
        hiddenThreads: [], ngIds: [], ngKeywords: []
    });

    if (!autoCleanupEnabled) return { success: true, message: 'Auto-cleanup is disabled.' };

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - cleanupDays);

    const migrate = (item) => (typeof item === 'string') ? { id: item, addedAt: new Date().toISOString() } : item;
    const migrateKeyword = (item) => (typeof item === 'string') ? { keyword: item, addedAt: new Date().toISOString() } : item;

    const newHiddenThreads = oldHiddenThreads.map(migrate).filter(item => new Date(item.addedAt) > threshold);
    const newNgIds = oldNgIds.map(migrate).filter(item => new Date(item.addedAt) > threshold);
    const newNgKeywords = (oldNgKeywords || []).map(migrateKeyword).filter(item => new Date(item.addedAt) > threshold);

    await browser.storage.local.set({
        hiddenThreads: newHiddenThreads,
        ngIds: newNgIds,
        ngKeywords: newNgKeywords
    });

    console.log(`Komica Helper: Cleanup complete. Removed ${oldHiddenThreads.length - newHiddenThreads.length} hidden threads, ${oldNgIds.length - newNgIds.length} NGIDs, and ${(oldNgKeywords || []).length - newNgKeywords.length} keywords.`);
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
    const records = hiddenThreads.map(item => (typeof item === 'string' ? { id: item, addedAt: null } : item));
    return { success: true, data: records };
}

async function getNgIds() {
    const { ngIds } = await browser.storage.local.get({ ngIds: [] });
    const records = ngIds.map(item => (typeof item === 'string' ? { id: item, addedAt: null } : item));
    return { success: true, data: records };
}

// --- NG 關鍵字函式 ---
async function addNgKeyword(keyword) {
    if (!keyword || keyword.trim() === '') return { success: false, error: 'Keyword cannot be empty' };
    const cleaned = keyword.trim();
    const { ngKeywords } = await browser.storage.local.get({ ngKeywords: [] });
    if (!ngKeywords.some(item => (item.keyword || item).toLowerCase() === cleaned.toLowerCase())) {
        ngKeywords.unshift({ keyword: cleaned, addedAt: new Date().toISOString() });
        await browser.storage.local.set({ ngKeywords });
        notifyAllTabs({ action: 'applyKeywordFilter' });
    }
    return { success: true };
}

async function removeNgKeyword(keyword) {
    let { ngKeywords } = await browser.storage.local.get({ ngKeywords: [] });
    const updated = ngKeywords.filter(item => (item.keyword || item).toLowerCase() !== keyword.toLowerCase());
    await browser.storage.local.set({ ngKeywords: updated });
    notifyAllTabs({ action: 'applyKeywordFilter' });
    return { success: true };
}

async function getNgKeywords() {
    const { ngKeywords } = await browser.storage.local.get({ ngKeywords: [] });
    const records = ngKeywords.map(item => (typeof item === 'string' ? { keyword: item, addedAt: null } : item));
    return { success: true, data: records };
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

// --- 貼文儲存與管理函式 ---
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

async function clearDeadPosts() {
    let { savedPosts } = await browser.storage.local.get({ savedPosts: [] });
    const initialCount = savedPosts.length;
    savedPosts = savedPosts.filter(p => !p.isDead);
    await browser.storage.local.set({ savedPosts });
    await updateBadge();
    return { success: true, removedCount: initialCount - savedPosts.length };
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

// --- 匯出與匯入 ---
async function exportData() {
    const allData = await browser.storage.local.get(null);
    return {
        success: true,
        data: {
            app: 'Komica-helper',
            version: '1.7.0.0',
            exportedAt: new Date().toISOString(),
            ...allData
        }
    };
}

async function importData({ data, mode = 'merge' }) {
    if (!data || typeof data !== 'object') {
        return { success: false, error: '資料格式不正確' };
    }
    try {
        if (mode === 'overwrite') {
            await browser.storage.local.clear();
            await browser.storage.local.set(data);
        } else {
            const current = await browser.storage.local.get(null);
            const merged = { ...current, ...data };

            // 合併 savedPosts (以 id 去重)
            if (Array.isArray(data.savedPosts)) {
                const map = new Map();
                (current.savedPosts || []).forEach(p => map.set(p.id, p));
                data.savedPosts.forEach(p => map.set(p.id, p));
                merged.savedPosts = Array.from(map.values());
            }

            // 合併 hiddenThreads
            if (Array.isArray(data.hiddenThreads)) {
                const map = new Map();
                (current.hiddenThreads || []).forEach(t => map.set(t.id || t, t));
                data.hiddenThreads.forEach(t => map.set(t.id || t, t));
                merged.hiddenThreads = Array.from(map.values());
            }

            // 合併 ngIds
            if (Array.isArray(data.ngIds)) {
                const map = new Map();
                (current.ngIds || []).forEach(id => map.set(id.id || id, id));
                data.ngIds.forEach(id => map.set(id.id || id, id));
                merged.ngIds = Array.from(map.values());
            }

            // 合併 ngKeywords
            if (Array.isArray(data.ngKeywords)) {
                const map = new Map();
                (current.ngKeywords || []).forEach(k => map.set((k.keyword || k).toLowerCase(), k));
                data.ngKeywords.forEach(k => map.set((k.keyword || k).toLowerCase(), k));
                merged.ngKeywords = Array.from(map.values());
            }

            await browser.storage.local.set(merged);
        }

        await updateCheckAlarm();
        await updateBadge();
        notifyAllTabs({ action: 'reapplyFunctions' });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function notifyAllTabs(message) {
    const patterns = [
        "*://*.komica1.org/*",
        "*://*.komica.org/*",
        "*://*.komica2.net/*",
        "*://*.2cat.org/*"
    ];
    for (const pattern of patterns) {
        try {
            const tabs = await browser.tabs.query({ url: pattern });
            for (const tab of tabs) {
                try {
                    await browser.tabs.sendMessage(tab.id, message);
                } catch (e) { }
            }
        } catch (e) { }
    }
}
