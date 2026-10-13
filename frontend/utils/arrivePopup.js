/**
 * 抵达事件队列播放（home / march 页共用）：
 * 按「节点抵达卡 → 章节完成仪式卡」顺序逐个弹出，统一卡片数据结构与停留时长。
 * 在页面实例上读写 litPopup / popupTimer；页面需在 onHide/onUnload 自行 clearTimeout。
 */

const NODE_CARD_MS = 2400;
const CHAPTER_CARD_MS = 3400; // 章节卡含历史介绍，停留稍久

function buildQueue(newlyLit, newChapters) {
  return (newlyLit || [])
    .map((n) => ({
      kind: 'node',
      name: n.name,
      icon: n.icon || '★',
      historicalTime: n.historicalTime || '',
      nextName: n.nextNode ? n.nextNode.name : '',
      nextRemain: n.nextNode ? n.nextNode.remain : 0
    }))
    .concat(
      (newChapters || []).map((c) => ({ kind: 'chapter', title: c.title, intro: c.intro || '' }))
    );
}

/**
 * @param {Object} page 页面实例（使用其 setData 与 popupTimer）
 * @param {Array} newlyLit light-up 返回的新点亮节点（含 nextNode）
 * @param {Array} newChapters light-up 返回的新完成章节（含 title/intro）
 * @returns {number} 队列总播放时长（ms），供页面安排后续跳转
 */
function playArriveQueue(page, newlyLit, newChapters) {
  const queue = buildQueue(newlyLit, newChapters);
  const cardMs = (card) => (card.kind === 'chapter' ? CHAPTER_CARD_MS : NODE_CARD_MS);
  let i = 0;
  const showNext = () => {
    if (i >= queue.length) {
      page.setData({ litPopup: null });
      return;
    }
    const card = queue[i];
    page.setData({ litPopup: card });
    i++;
    if (page.popupTimer) clearTimeout(page.popupTimer);
    page.popupTimer = setTimeout(showNext, cardMs(card));
  };
  showNext();
  return queue.reduce((sum, card) => sum + cardMs(card), 0);
}

module.exports = { playArriveQueue };
