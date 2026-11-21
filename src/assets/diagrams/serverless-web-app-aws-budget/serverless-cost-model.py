# Monthly cost model, us-east-1 list prices (Nov 2026). Run: python3 calc.py
P = dict(cf_gb=0.085, cf_req=1.00, apigw=1.00, l_req=0.20, l_gbs_arm=0.0000133334,
         rru=0.125, wru=0.625, ddb_gb=0.25, pitr_gb=0.20, s3_gb=0.023, s3_put=0.005, s3_get=0.0004,
         cog_lite=0.0055, cog_ess=0.015, waf_acl=5, waf_rule=1, waf_req=0.60, r53=0.50,
         logs_gb=0.50, alarm=0.10, ses_k=0.16)

def stage(name, mau, dau, s3_gb, ddb_gb, emails, free=True, cognito='lite'):
    sess = dau * 30 * 2                      # 2 sessions per active user per day
    api = sess * 25                          # API calls per session
    cf_req = sess * 12 + api                 # html+assets+images, and /api via CloudFront
    cf_gb = sess * 0.9 / 1000 + api * 3 / 1e6  # 0.9 MB static per session, 3 KB per API response
    gbs = api * 0.5 * 0.08                   # 512 MB arm64, 80 ms average billed
    logs_gb = api * 2 / 1e6                  # ~2 KB of logs per request (Lambda + access log)
    li = {}
    li['CloudFront'] = max(cf_gb - (1000 if free else 0), 0) * P['cf_gb'] + max(cf_req / 1e6 - (10 if free else 0), 0) * P['cf_req']
    li['AWS WAF (ACL + 4 rules)'] = P['waf_acl'] + 4 * P['waf_rule'] + cf_req / 1e6 * P['waf_req']
    li['API Gateway HTTP API'] = api / 1e6 * P['apigw']
    li['Lambda (arm64)'] = max(api / 1e6 - (1 if free else 0), 0) * P['l_req'] + max(gbs - (400000 if free else 0), 0) * P['l_gbs_arm']
    li['DynamoDB on-demand + PITR'] = api * 2 / 1e6 * P['rru'] + api * 0.4 / 1e6 * P['wru'] + max(ddb_gb - (25 if free else 0), 0) * P['ddb_gb'] + ddb_gb * P['pitr_gb']
    li['S3'] = s3_gb * P['s3_gb'] + mau * 3 / 1000 * P['s3_put'] + sess * 8 * 0.1 / 1000 * P['s3_get']
    rate = P['cog_lite'] if cognito == 'lite' else P['cog_ess']
    li['Cognito (%s)' % cognito] = max(mau - 10000, 0) * rate
    li['Route 53 zone'] = P['r53']
    li['CloudWatch logs + alarms'] = max(logs_gb - (5 if free else 0), 0) * P['logs_gb'] + 8 * P['alarm']
    li['SES digests'] = emails / 1000 * P['ses_k']
    tot = sum(li.values())
    print(f'\n== {name}: MAU {mau:,} DAU {dau:,} sessions {sess:,} api {api/1e6:.2f}M cf_req {cf_req/1e6:.2f}M cf_gb {cf_gb:.0f} GB-s {gbs:,.0f} logs {logs_gb:.1f}GB')
    for k, v in li.items(): print(f'  {k:32s} ${v:8.2f}')
    print(f'  {"TOTAL":32s} ${tot:8.2f}')
    return li

stage('Launch, list', 5000, 1500, 25, 3, 20000, free=False)
stage('Launch, always-free applied', 5000, 1500, 25, 3, 20000)
stage('Growth', 50000, 15000, 250, 30, 200000)
stage('Growth, Essentials', 50000, 15000, 250, 30, 200000, cognito='essentials')
# TV spike: 80k one-off sessions in 3 hours, 12k sign-ups
s = 80000; api = s * 25
print('\nSpike: api', api, 'avg rps', api / 10800, 'peak rps (x4)', api / 10800 * 4)
print(' concurrency at peak (120ms avg)', api / 10800 * 4 * 0.12)
cf = s * 12 + api; gb = s * 0.9 / 1000 + api * 3e-6
cost = api / 1e6 * (P['apigw'] + P['l_req'] + 0.04 * 1e6 * P['l_gbs_arm'] + 2 * P['rru'] + 0.4 * P['wru']) + cf / 1e6 * (P['cf_req'] + P['waf_req']) + gb * P['cf_gb'] + 12000 * P['cog_lite']
print(' cf req', cf, 'gb', gb, 'marginal cost (no free tier) $%.2f' % cost, 'of which cognito', 12000 * P['cog_lite'])
