import { Body } from '@tauri-apps/api/http'
import { Message } from '@arco-design/web-vue'
import { request } from '.'
import { OPENAI_CHAT_URL, OPEN_AI_MODEL, OPENAI_CREDIT_URL } from '@/constants'
import {
  fetchEventSource,
  type EventSourceMessage
} from '@microsoft/fetch-event-source'
import { useSessionStore, useSettingsStore, useRoleStore } from '@/stores'
import { executeSQL } from '@/sqls'
import type { MessageData, SessionData } from '@/types'

/**
 * 获取 openai 对话消息
 * @param messages 消息列表
 */
export const getOpenAIResultApi = async (messages: MessageData[]) => {
  if (!messages.length) return

  const apiKey = getOpenAIKey()
  if (!apiKey) return

  return await request(OPENAI_CHAT_URL, {
    method: 'POST',
    body: Body.json({
      model: OPEN_AI_MODEL,
      messages
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  })
}

/**
 * 获取 openai 对话消息(流)
 * @param messages 消息列表
 */
export const getOpenAIResultStreamApi = async (messages: MessageData[]) => {
  if (!messages.length) return

  const apiKey = getOpenAIKey()
  if (!apiKey) return

  const { updateSessionData } = useSessionStore()
  const { sessionDataList } = storeToRefs(useSessionStore())

  await fetchEventSource(OPENAI_CHAT_URL, {
    method: 'POST',
    body: JSON.stringify({
      model: OPEN_AI_MODEL,
      messages,
      temperature: 0.6,
      stream: true
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    async onopen(response) {
      if (response.ok) return

      if (response.status === 429) {
        throw new Error('请求的 key 超出限制')
      } else if (response.status === 401) {
        throw new Error('请求的 API KEY 无效')
      } else {
        throw new Error('请求出错')
      }
    },
    onmessage(msg: EventSourceMessage) {
      if (msg.data !== '[DONE]') {
        const { choices } = JSON.parse(msg.data)

        if (!choices[0].delta.content) return

        sessionDataList.value.at(-1)!.message.content +=
          choices[0].delta.content
      }
    },
    onclose() {
      updateSessionData(sessionDataList.value.at(-1)!)
    },
    onerror({ message }: any) {
      throw new Error(message)
    }
  })
}

/**
 * 获取账号余额信息
 */
export const getOpenAICreditApi = async () => {
  const apiKey = getOpenAIKey()
  if (!apiKey) return

  return await request(OPENAI_CREDIT_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  })
}

/**
 * 获取 ai 回答
 * @param value 消息内容
 */
export const getAiMessage = async (value?: string) => {
  const { isThinking, sessionDataList } = storeToRefs(useSessionStore())
  const { updateSessionData } = useSessionStore()

  try {
    const { currentRole } = useRoleStore()

    if (!currentRole) return

    // 检测是否有余额
    const credit = await getOpenAICreditApi()
    if (!credit) return

    const messages: MessageData[] = []

    const { currentSession, sessionDataList } = useSessionStore()
    const { isMemory } = useSettingsStore()

    const lastQuestion = sessionDataList.filter((item) => item.is_ask).at(-1)

    // 记忆模式，或者是第一次对话，都要生成角色描述
    if (sessionDataList.length < 3 || isMemory) {
      messages.push({
        role: 'system',
        content: currentRole.description
      })
    }

    // 获取记忆（限制5条），往前推直到出现 is_momery 为 false 的
    // TODO 应该进行限流，防止出现过多的记忆，导致token超出
    const addMemory = async () => {
      if (isMemory) {
        // TODO: 优化 sql
        const sql = `SELECT * FROM session_data WHERE session_id = '${currentSession?.id}' ORDER BY id DESC LIMIT 5;`
        const memoryList = (await executeSQL(sql)) as SessionData[]

        let count = 0
        const arr = []
        while (count < memoryList.length) {
          if (!memoryList[count].is_memory) break
          arr.push(JSON.parse(memoryList[count++].message as any))
        }
        messages.push(...arr.reverse())
      }
    }

    // 再次生成上一次问题
    if (!value) {
      if (!lastQuestion) return

      // 为了保证统一，这之后的内容全部删掉
      const deleteSql = `DELETE FROM session_data WHERE session_id = '${lastQuestion?.session_id}' AND id >= ${lastQuestion?.id};`
      await executeSQL(deleteSql)

      await addMemory()
      messages.push(lastQuestion?.message)
    } else {
      await addMemory()
      messages.push({
        role: 'user',
        content: value
      })
    }

    const { isThinking } = storeToRefs(useSessionStore())
    const { addSessionData } = useSessionStore()

    isThinking.value = true

    await addSessionData({
      isAsk: true,
      data: messages.at(-1)!
    })

    await addSessionData({
      isAsk: false,
      data: {
        role: 'assistant',
        content: ''
      }
    })

    await getOpenAIResultStreamApi(messages)

    isThinking.value = false
  } catch ({ message }: any) {
    sessionDataList.value.at(-1)!.message.content = message as any

    updateSessionData(sessionDataList.value.at(-1)!)

    isThinking.value = false
  }
}

/**
 * 获取apiKey
 */
const getOpenAIKey = () => {
  const { apiKey } = useSettingsStore()

  if (!apiKey && !import.meta.env.VITE_OPEN_AI_API_KEY) {
    Message.warning('请先填写 OpenAi API Key')
    return false
  }

  return apiKey || import.meta.env.VITE_OPEN_AI_API_KEY
}
