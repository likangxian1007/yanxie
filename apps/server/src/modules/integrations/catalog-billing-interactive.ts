/** 余额、充值与积分调整只给网页会话；KyrenPay webhook 自带验签、不走令牌。逐条登记，避免被意外开放给令牌。 */
export const BILLING_INTERACTIVE_ROUTES = new Set([
  'GET /billing/me',
  'GET /billing/orders/:ref',
  'POST /admin/credits',
  'POST /billing/kyren-webhook',
  'POST /billing/topup',
]);
