export interface GetTradesOpts {
    account?: string
    market?: string
    limit?: number
    before_id?: number
    after_id?: number
    order_id?: string
    after_block?: number
    before_block?: number
}
