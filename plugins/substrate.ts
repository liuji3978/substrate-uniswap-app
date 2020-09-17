import { Plugin } from '@nuxt/types'
import { ApiPromise, WsProvider } from '@polkadot/api'

/**
 * 异步初始化
 */
const substratePlugin: Plugin = async (context, inject) => {
  const providerUrl = context.env.NODE_URL || 'ws://127.0.0.1:9944'
  const provider = new WsProvider(providerUrl)
  const api = await ApiPromise.create({ provider }).then(api => {
    // 打印连接成功
    console.log(`Substrate node connected. url: ${providerUrl}`)
    // 断线则重设api
    api.on('disconnected', () => console.log(`node disconnected!!!`))
    return api
  })
  inject('api', api)
}
export default substratePlugin
