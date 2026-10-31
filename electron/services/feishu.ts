import * as lark from '@larksuiteoapi/node-sdk';
import logger from './logger';

let webhookUrl: any = null;
let wsClient: any = null;
let client: any = null;
let running = false;
let messageHandler: any = null;
let cardActionHandler: any = null;

/** 设置卡片按钮回调处理器（点击按钮时触发，入参见 card.action.trigger 事件结构） */
function setCardActionHandler(fn: ((action: any) => void) | null) {
  cardActionHandler = fn;
}

// ========== Webhook (simple send-only, no SDK needed) ==========

async function sendViaWebhook(url, message) {
  if (!url) return { ok: false, error: 'Webhook URL 未配置' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text: message }),
      }),
    });
    const data: any = await res.json();
    return { ok: data.code === 0 || data.StatusCode === 0 || res.ok, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function setWebhook(url) {
  webhookUrl = url;
}

function getWebhook() {
  return webhookUrl;
}

// ========== Event Subscription via SDK (WebSocket long connection) ==========

async function start(configData, onMessage) {
  if (running) stop();
  messageHandler = onMessage;
  running = true;

  try {
    const baseConfig = {
      appId: configData.app_id || configData.appId,
      appSecret: configData.app_secret || configData.appSecret,
    };
    if (!baseConfig.appId || !baseConfig.appSecret) {
      logger.error('[Feishu] start: missing appId or appSecret');
      running = false;
      return false;
    }

    logger.info('[Feishu] Creating Lark.Client...');
    client = new lark.Client(baseConfig);

    logger.info('[Feishu] Creating Lark.WSClient...');
    wsClient = new lark.WSClient({
      ...baseConfig,
      loggerLevel: lark.LoggerLevel.debug,
    });

    logger.info('[Feishu] Starting WSClient...');
    wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          logger.info('[Feishu] WS event received: im.message.receive_v1');
          try {
            logger.info('[Feishu] Raw event data: %s', JSON.stringify(data).slice(0, 1000));
            const event = (data as any).event || data;
            const message = event.message || data.message;
            const sender = event.sender || data.sender;
            logger.info('[Feishu] Parsed - message: %s, sender: %s', JSON.stringify(message).slice(0, 300), JSON.stringify(sender).slice(0, 300));
            if (!message || !sender) {
              logger.warn('[Feishu] Missing message or sender in event');
              return;
            }

            const contentRaw = message.content;
            logger.info('[Feishu] Message content raw: %s', contentRaw);
            const content = JSON.parse(contentRaw);
            const text = content.text || '';
            const openId = sender.sender_id?.open_id || sender.open_id || '';
            const chatId = message.chat_id || '';
            const chatType = message.chat_type || 'p2p';
            const messageId = message.message_id || '';
            logger.info('[Feishu] Parsed message - text: "%s", openId: %s, chatId: %s, chatType: %s, messageId: %s', text.slice(0, 200), openId, chatId, chatType, messageId);
            logger.info('[Feishu] Receive check: text=%s openId=%s chatType=%s hasHandler=%s', !!text, !!openId, chatType, !!messageHandler);
            if (text && openId && messageHandler) {
              const cleaned = text.replace(/@_user_\d+/g, '').trim();
              logger.info('[Feishu] Dispatching to messageHandler: "%s"', cleaned);
              messageHandler({
                text: cleaned,
                sender: openId,
                chatId: chatId,
                chatType: chatType,
                messageId: messageId,
              });
            } else {
              logger.warn('[Feishu] Missing text/openId/handler: text=%s, openId=%s, handler=%s', !!text, !!openId, !!messageHandler);
            }
          } catch (e) {
            logger.error('[Feishu] Event handler error: %s', e.message);
            logger.error('[Feishu] Event handler error stack: %s', e.stack);
          }
        },
        // 卡片按钮回调：点击交互卡片上的按钮时触发。
        // 需要在飞书开放平台为该应用订阅「卡片回调」事件，否则收不到点击。
        // ⚠️ 飞书要求回调 3 秒内响应，超时客户端会弹「目标回调服务超时未响应」：
        // 这里只做事件解析，handler 只能做快速校验并返回响应体（如 { toast: {...} }），
        // 慢活（派 AI 任务）由 handler 自己丢到后台执行，绝不能在这里 await。
        'card.action.trigger': async (data: any) => {
          try {
            const event = (data as any).event || data;
            const action = event.action || {};
            const context = event.context || {};
            const operator = event.operator || {};
            const payload = {
              value: action.value,
              tag: action.tag,
              name: action.name,
              messageId: context.open_message_id || event.open_message_id || '',
              chatId: context.open_chat_id || event.open_chat_id || '',
              operatorOpenId: operator.open_id || '',
              operatorName: operator.name || '',
              raw: event,
            };
            logger.info('[Feishu] Card action: value=%s chatId=%s operator=%s',
              JSON.stringify(payload.value), payload.chatId, payload.operatorOpenId);
            // 返回值（toast / card）作为回调响应回传，点击后立刻轻提示，不用等任务执行完
            if (cardActionHandler) return await cardActionHandler(payload);
            logger.warn('[Feishu] Card action received but no handler registered');
            return undefined;
          } catch (e) {
            logger.error('[Feishu] Card action handler error: %s', e.message);
            return undefined;   // 出错也回个空 OK，别让客户端一直等
          }
        },
      }),
    });

    logger.info('[Feishu] WSClient started successfully');
    return true;
  } catch (e) {
    logger.error('[Feishu] SDK start error: %s', e.message);
    logger.error('[Feishu] SDK start error stack: %s', e.stack);
    running = false;
    return false;
  }
}

async function sendMessage(receiveId, receiveIdType, content, msgType = 'text') {
  if (!client) {
    logger.warn('[Feishu] sendMessage: no client');
    return;
  }
  try {
    logger.info('[Feishu] Sending message to %s (type=%s): "%s"', receiveId, receiveIdType, (typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 200));
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content: typeof content === 'string'
          ? JSON.stringify({ text: content })
          : JSON.stringify(content),
      },
    });
    logger.info('[Feishu] Message sent successfully');
  } catch (e) {
    logger.error('[Feishu] sendMessage error: %s', e.message);
    if (e.response) logger.error('[Feishu] sendMessage response: %s', JSON.stringify(e.response).slice(0, 500));
  }
}

function replyMessage(msg, content, msgType?) {
  logger.info('[Feishu] replyMessage: chatId=%s chatType=%s sender=%s msgType=%s', msg.chatId, msg.chatType, msg.sender, msgType);
  if (msg.chatType === 'group' && msg.chatId) {
    return sendMessage(msg.chatId, 'chat_id', content, msgType);
  }
  if (msg.sender) {
    return sendMessage(msg.sender, 'open_id', content, msgType);
  }
  logger.error('[Feishu] replyMessage: no valid target (sender=%s chatId=%s)', msg.sender, msg.chatId);
}

/**
 * 构造交互卡片的 elements 数组（纯函数，便于单测）。
 * extra.note：卡片底部的一行小字说明（如「本条发到：笔记库」）。
 * extra.buttons：按钮组，每个按钮带 value（点击后通过 card.action.trigger 回传）。
 */
export function buildCardElements(content: string, extra?: { note?: string; buttons?: Array<{ text: string; value: any; type?: string; url?: string }> }) {
  const elements: any[] = [{ tag: 'markdown', content }];
  if (extra?.note) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: extra.note }] });
  }
  if (extra?.buttons && extra.buttons.length) {
    elements.push({
      tag: 'action',
      actions: extra.buttons.map((b) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.text },
        type: b.type || 'default',
        value: b.value,
        ...(b.url ? { url: b.url } : {}),
      })),
    });
  }
  return elements;
}

/**
 * 发送交互卡片。
 * extra.note：卡片底部的一行小字说明（如「本条发到：笔记库」）。
 * extra.buttons：按钮组，每个按钮带 value（点击后通过 card.action.trigger 回传）。
 */
async function replyCard(msg, content, headerText?, extra?: { note?: string; buttons?: Array<{ text: string; value: any; type?: string; url?: string }> }) {
  logger.info('[Feishu] replyCard: chatId=%s chatType=%s sender=%s', msg.chatId, msg.chatType, msg.sender);
  const target = msg.chatType === 'group' ? msg.chatId : msg.sender;
  const targetType = msg.chatType === 'group' ? 'chat_id' : 'open_id';
  if (!target) {
    logger.error('[Feishu] replyCard: no valid target');
    return;
  }
  if (!client) {
    logger.warn('[Feishu] replyCard: no client');
    return;
  }
  try {
    await client.im.message.create({
      params: { receive_id_type: targetType },
      data: {
        receive_id: target,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: buildCardElements(content, extra),
          header: headerText
            ? { template: 'blue', title: { tag: 'plain_text', content: headerText } }
            : { template: 'blue', title: { tag: 'plain_text', content: '启航AI' } },
        }),
      },
    });
    logger.info('[Feishu] Card sent successfully');
  } catch (e) {
    logger.error('[Feishu] replyCard error: %s', e.message);
  }
}

function stop() {
  logger.info('[Feishu] Stopping...');
  running = false;
  if (wsClient) {
    try { wsClient.stop?.(); } catch (e) { logger.error('[Feishu] stop error: %s', e?.message); }
    wsClient = null;
  }
  client = null;
  logger.info('[Feishu] Stopped');
}

function isRunning() {
  return running;
}

export { sendViaWebhook, setWebhook, getWebhook, start, stop, isRunning, sendMessage, replyMessage, replyCard, setCardActionHandler };
