import { GetterTree, ActionTree, MutationTree } from 'vuex'
import { Option } from '@polkadot/types/codec'
import { Hash } from '@polkadot/types/interfaces/runtime'
import { RootState } from '~/store'
import { TradePair, User } from '~/types'

export const state = () => ({
  currentIndex: -1,
  tradePairs: [] as TradePair[],
  tradePairLength: -1
})

export type ModuleState = ReturnType<typeof state>

export const getters: GetterTree<ModuleState, RootState> = {
  currentTradePair: state => state.currentIndex >= 0 ? state.tradePairs[state.currentIndex] : null
}

export const mutations: MutationTree<ModuleState> = {
  SETUP_ALL_TRADE_PAIRS: (state, payload: { tradePairs: TradePair[] }) => (state.tradePairs = payload.tradePairs),
  SET_CURRENT_TRADE_PAIR: (state, index: number) => {
    const current = state.tradePairs[index]
    if (!current && index >= 0) {
      throw new Error(`failed to set trade pair, index should be [0~${state.tradePairs.length - 1}] instead of ${index}`)
    }
    state.currentIndex = index
  },
  SET_TRADE_PAIR_LENGTH: (state, payload: { len: number }) => (state.tradePairLength = payload.len)
}

export type PayloadFetchTradePairByBaseQuote = { base: string, quote: string, isSetCurrent?: boolean }
export type PayloadCreateTradePair = { base: string, quote: string, baseAmount: number, quoteAmount: number }
export type PayloadAddLiquidity = { hash: string, baseAmount: number, quoteAmount?: number }
export type PayloadRemoveLiquidity = { hash: string, ltAmount: number }
export type PayloadBuy = { hash: string, baseAmount: number }
export type PayloadSell = { hash: string, quoteAmount: number }


export const actions: ActionTree<ModuleState, RootState> = {
  /**
   * 查询全部交易对
   */
  async queryTradePairs (ctx, payload: { isForce?: boolean } = {}) {
    await this.$ensureApiConnected()
    if (!payload.isForce) {
      // 第一次需要获取 index
      const oldLength = ctx.state.tradePairLength
      await ctx.dispatch('fetchTradePairsLength')
      if (oldLength === ctx.state.tradePairLength) return
    }
    const len = ctx.state.tradePairLength
    // 从 0 ~ length index 一路查过去
    const indexes = []
    for (let i = 0; i < len; i++) { indexes.push(i) }
    // 并发获取信息
    const tradePairs = (await Promise.all(indexes.map(async index => {
      const hash = (await this.$api.query.swapModule.tradePairsHashByIndex(index)) as Option<Hash>
      if (hash.isSome) {
        const token = (await this.$api.query.swapModule.tradePairs(hash.unwrap())) as Option<TradePair>
        return token.isSome ? token.unwrap() : null
      }
      return null
    }))).filter(one => one !== null)
    // 需要请求 substrate 获取 tokens
    ctx.commit('SETUP_ALL_TRADE_PAIRS', { tradePairs })
  },
  /**
   * 获取交易对数量
   */
  async fetchTradePairsLength (ctx) {
    await this.$ensureApiConnected()
    const len = await this.$api.query.swapModule.tradePairsIndex()
    ctx.commit('SET_TRADE_PAIR_LENGTH', {
      len: parseInt(len.toHuman()?.valueOf() as string)
    })
    return len
  },
  /**
   * 获取交易对
   */
  async fetchTradePairByBaseQuote (ctx, payload: PayloadFetchTradePairByBaseQuote) {
    let hash = (await this.$api.query.swapModule.tradePairsHashByBaseQuote([payload.base, payload.quote])) as Option<Hash>
    if (hash.isNone) {
      hash = (await this.$api.query.swapModule.tradePairsHashByBaseQuote([payload.quote, payload.base])) as Option<Hash>
    }
    if (hash.isSome) {
      const tpHash = hash.unwrap()
      const index = ctx.state.tradePairs.findIndex(tp => tp.tp_hash.toHex() === tpHash.toHex())
      if (index !== -1) {
        if (payload.isSetCurrent) {
          ctx.commit('SET_CURRENT_TRADE_PAIR', index)
        }
        return ctx.state.tradePairs[index]
      }
      // 获取实时数据
      const result = (await this.$api.query.swapModule.tradePairs(tpHash)) as Option<TradePair>
      if (result.isSome) return result.unwrap()
    }
    return null
  },
  /**
   * 创建交易对
   * 由 管理员 执行
   */
  async createNewTradePair (ctx, payload: PayloadCreateTradePair) {
    await this.$ensureApiConnected()
    console.log('createNewTradePair', payload)
    // 构建交易
    // const extrinsic = this.$api.tx.swapModule.createTradePair(payload.base, payload.quote)
    const extrinsic = this.$api.tx.utility.batch([
      this.$api.tx.swapModule.createTradePair(payload.base, payload.quote),
      this.$api.tx.swapModule.addLiquidityByBaseQuote(payload.base, payload.quote, payload.baseAmount, payload.quoteAmount)
    ])
    // 交易签名并发送
    const keypair = (ctx.rootGetters['currentUser'] as User)?.keypair
    await extrinsic.signAndSend(keypair, this.$txSendingCallback(async result => {
      // 当 finalized 时，获取最新的 token length
      if (result.isInBlock) {
        await ctx.dispatch('tokens/fetchTokenLengthIndex', null, { root: true })
        await ctx.dispatch('fetchTradePairsLength')
      }
    }))
  },
  /**
   * 添加流动性
   * 由 持币人 执行
   */
  async addLiquidityToTradePair (ctx, payload: PayloadAddLiquidity) {
    await this.$ensureApiConnected()
    console.log('addLiquidityToTradePair', payload)
    // 构建交易
    const extrinsic = this.$api.tx.swapModule.addLiquidity(payload.hash, payload.baseAmount, payload.quoteAmount || null)
    // 交易签名并发送
    const keypair = (ctx.rootGetters['currentUser'] as User)?.keypair
    await extrinsic.signAndSend(keypair, this.$txSendingCallback(async result => {
      if (result.isInBlock) {
        await ctx.commit('tokens/SET_BALANCE_DIRTY', true, { root: true })
      }
    }))
  },
  /**
   * 移出流动性
   * 由 流动性供应商 执行
   */
  async removeLiquidityFromTradePair (ctx, payload: PayloadRemoveLiquidity) {
    await this.$ensureApiConnected()
    console.log('removeLiquidityFromTradePair', payload)
    // 构建交易
    const extrinsic = this.$api.tx.swapModule.removeLiquidity(payload.hash, payload.ltAmount)
    // 交易签名并发送
    const keypair = (ctx.rootGetters['currentUser'] as User)?.keypair
    await extrinsic.signAndSend(keypair, this.$txSendingCallback(async result => {
      if (result.isInBlock) {
        await ctx.commit('tokens/SET_BALANCE_DIRTY', true, { root: true })
      }
    }))
  },
  /**
   * 从交易池中以买方操作 Swap
   * 由 持币人 执行
   */
  async buyTokenInTradePair (ctx, payload: PayloadBuy) {
    await this.$ensureApiConnected()
    console.log('buyTokenInTradePair', payload)
    // 构建交易
    const extrinsic = this.$api.tx.swapModule.swapBuy(payload.hash, payload.baseAmount)
    // 交易签名并发送
    const keypair = (ctx.rootGetters['currentUser'] as User)?.keypair
    await extrinsic.signAndSend(keypair, this.$txSendingCallback(async result => {
      if (result.isInBlock) {
        await ctx.commit('tokens/SET_BALANCE_DIRTY', true, { root: true })
      }
    }))
  },
  /**
   * 从交易池中以卖方操作 Swap
   * 由 持币人 执行
   */
  async sellTokenInTradePair (ctx, payload: PayloadSell) {
    await this.$ensureApiConnected()
    console.log('sellTokenInTradePair', payload)
    // 构建交易
    const extrinsic = this.$api.tx.swapModule.swapSell(payload.hash, payload.quoteAmount)
    // 交易签名并发送
    const keypair = (ctx.rootGetters['currentUser'] as User)?.keypair
    await extrinsic.signAndSend(keypair, this.$txSendingCallback(async result => {
      if (result.isInBlock) {
        await ctx.commit('tokens/SET_BALANCE_DIRTY', true, { root: true })
      }
    }))
  }
}
