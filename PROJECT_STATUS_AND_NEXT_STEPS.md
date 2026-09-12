# Kaliganj Travels — সম্পন্ন কাজ ও পরবর্তী ধাপ

## Current verified status (2026-09-11)

- [x] Owner verified and promoted to Super Admin; authenticated Users & Roles page confirmed.
- [x] 11 bank accounts and 6 MFS receiving accounts configured and verified.
- [x] Owner configured active all-airline/all-route rules: B2B 1%, B2C 4% of supplier payable, capped at gross.
- [x] Live rule read-back and five in-memory pricing checks passed, including both gross caps and Super Admin supplier pricing. Run `npm run verify:kaliganj-markup`. This does not replace full search/booking E2E.
- [ ] NEXT: Email/SMTP credentials and sender configuration in local env; connection verification, then an explicitly authorized test email.
- [ ] SMS credentials, branch/license details, repository/hosting, webhooks/schedules and remaining E2E checks follow.

This current-status block supersedes historical account/payment/markup pending notes below.


শেষ হালনাগাদ: **১১ সেপ্টেম্বর ২০২৬**।

## বর্তমান অবস্থা

**নতুন hosted database install ও application rebranding সম্পন্ন। প্রজেক্ট এখনো production launch-এর জন্য পুরোপুরি প্রস্তুত নয়।** Super Admin, কিছু service configuration, business settings, deployment এবং পূর্ণ workflow testing বাকি।

এই checklist বর্তমান source, local env-এর key উপস্থিতি, installation report ও সর্বশেষ rebranding report মিলিয়ে তৈরি। পরবর্তী live service verification-এর ফল নিচের অগ্রগতি অংশে যোগ করা হয়েছে; account creation ও deployment এখনো হয়নি। পুরোনো audit-এর historical “বাকি” তালিকার বদলে পরবর্তী কাজের জন্য এই ফাইল ব্যবহার করতে হবে।

**অবশ্যপালনীয় শর্ত:** আগের কোম্পানির user, booking, wallet balance, ledger, passenger/document, media library, cache বা business configuration এই project-এ import করা হবে না। নতুন account/settings ও নতুন কাজের data দিয়েই শুরু হবে। পুরোনো GitHub repository ও services অপরিবর্তিত থাকবে।

চিহ্ন: `[x]` সম্পন্ন/যাচাইয়ের রেকর্ড আছে; `[ ]` বাকি। Credentials ফাইলে থাকা মানেই service test পাস নয়।

## ১. যা সম্পন্ন হয়েছে

### Project ও database

- [x] Local Git history/remote connection সরানো হয়েছে; এখনো নতুন repository তৈরি হয়নি।
- [x] নতুন Supabase project: `ljzoizsogbirlvlsrwzi`। Root ও fresh-install—দুইটি CLI link সঠিক project-এ।
- [x] পুরোনো booking-specific repair ও company seed বাদ দিয়ে নতুন database baseline প্রস্তুত ও install করা হয়েছে।
- [x] Hosted database-এ **৮২টি table ও ৩০৩টি public function** পাওয়া গেছে; সব table-এ RLS যাচাই হয়েছে।
- [x] REST checks ও read-only lifecycle RPC পরীক্ষা পাস হয়েছে।
- [x] পুরোনো business data import হয়নি; baseline-এর পরে শুধু নতুন settings ও তিনটি inactive offer-editor slot ছিল।
- [x] নতুন database-এ company phone/email/address forward migration দিয়ে update হয়েছে।
- [x] Triplover selected; database-এ booking/ticketing বন্ধ রাখা আছে।
- [x] স্থানীয় `SUPABASE_DB_PASSWORD` এবং কার্যকর `DATABASE_URL` password মিলিয়ে দেওয়া হয়েছে।
- [x] Applied baseline-এর checksum সংরক্ষিত; সেটি overwrite আটকানো আছে। মূল legacy migration sources অক্ষত।

**Data সম্পর্কে নির্ভুল অবস্থা:** সর্বশেষ rebranding report অনুযায়ী business tables খালি ছিল। Security verification থেকে একটি নতুন `system:verification` audit event ও একটি temporary rate-limit bucket তৈরি হয়েছে। এগুলো এই নতুন project-এর diagnostic records, আগের কোম্পানির data নয়। Database-কে সম্পূর্ণ শূন্য row-এর বলে দেখাতে এগুলো মুছে দেওয়া হয়নি।

### Branding ও application configuration

- [x] Display name ও package identity: **Kaliganj Travels / `kaliganj-travels`**।
- [x] Reference logo স্থানীয় `public/brand/kaliganj-logo.png`-এ রাখা হয়েছে; uploaded logo না থাকলে এটি ব্যবহৃত হয়।
- [x] Orange/deep-blue theme, header/footer, login, dashboard, search ও wallet/ticket-management labels update হয়েছে।
- [x] Page titles/SEO, public contacts, email templates, booking headers, PDF/Excel identity update হয়েছে।
- [x] Supplier booking contact নতুন company email ও phone ব্যবহার করে।
- [x] পুরোনো hardcoded BCC সরানো হয়েছে; `SYSTEM_EMAIL_BCC` optional configuration।
- [x] SMTP এখন generic `SMTP_PASSWORD` ব্যবহার করে।
- [x] Cloudinary ও marketing seed-এর namespace এখন `kaliganj-travels/...`। এটি code change; নতুন asset upload verification এখনো বাকি।
- [x] Runtime থেকে পুরোনো company name/contact/license fallback সরানো হয়েছে। পুরোনো audit/migration references development record হিসেবে আছে।
- [x] আগের feature/business logic রাখা হয়েছে; booking/agency reference format compatibility-এর জন্য অপরিবর্তিত।

### পরীক্ষার রেকর্ড

- [x] Rebranding report-এ lint, production build/TypeScript এবং branding verification পাসের রেকর্ড আছে।
- [x] Fresh database installation, নতুন company snapshot ও immutable snapshot পরীক্ষা পাস।
- [x] Email template/BCC, agency logo, booking share, wallet, IMP/EXP এবং ticket-management UI-এর সংশ্লিষ্ট checks পাস।
- [x] Desktop/mobile public UI, email HTML ও ticket PDF visually inspected হয়েছে।
- [ ] সব role দিয়ে authenticated dashboard ও পূর্ণ supplier/financial workflow এখনো পরীক্ষা হয়নি।
- [ ] `verify:canonical-pricing-regression` পুরোনো Git HEAD-এর উপর নির্ভরশীল; Git history না থাকায় testটি এখন চলতে পারে না। নতুন baseline-ভিত্তিক meaningful regression check প্রয়োজন।

## ২. Service readiness

| Service | কী আছে | কী বাকি |
|---|---|---|
| Supabase | Credentials, schema ও hosted checks সম্পন্ন | Admin/business settings, পরবর্তী operational checks |
| Clerk | নতুন keys ও webhook signing secret env-এ আছে | Owner account, `superadmin` role, verification/login, webhook/domain setup |
| Redis | Credentials ও Redis quote-store configuration আছে | Connection, synthetic write/read ও expiry পাস; application quote workflow E2E বাকি |
| Cloudinary | Credentials, নতুন namespace ও local logo আছে | Upload/read/private access ও link expiry পাস; নিজস্ব marketing artwork বাকি |
| Triplover | Credentials আছে; database-এ selected | Authentication/search/reprice পাস; application E2E ও অনুমোদিত booking/ticketing workflow test বাকি |
| FirstTrip / TakeOff | Integration code আছে | Credentials ও account-specific verification; ব্যবহারকারী পরে দেবেন |
| Email / SMTP | নতুন templates, sender-name fallback ও optional BCC code আছে | SMTP credentials, sender/reply-to, প্রয়োজনে BCC; delivery tests |
| Bulk SMS | Integration code আছে; পুরোনো admin numbers সরানো | API key/sender, নতুন admin recipient list ও delivery tests |
| Cron / Vault | Protected endpoints ও `CRON_SECRET` আছে | নতুন deployment-এর Vault values, schedules ও worker verification |
| GitHub / Vercel | Application code ও build প্রস্তুত | নতুন repo, Vercel project, env, preview ও domain deployment |

`VERCEL_OIDC_TOKEN` বর্তমানে application code-এর প্রয়োজনীয় credential হিসেবে পাওয়া যায়নি। শুধু এটি অনুপস্থিত বলে local setup আটকাবে না; নতুন Vercel deployment-এর নিজস্ব authentication/configuration করতে হবে।

## ৩. Email ও company identity—কোনটি কোন কাজে

| ব্যবহার | বর্তমান সিদ্ধান্ত |
|---|---|
| Super Admin login | **`kaliganjtravels@gmail.com`** — ব্যবহারকারী নিশ্চিত করেছেন; account/role setup বাকি |
| Public support ও supplier booking contact | **`support@kaliganjtravel.com`** — বর্তমান `lib/site.ts` ও branding report অনুযায়ী |
| Phone / WhatsApp | **+880 1795-271171** |
| Address | **1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh** |
| Brand reference website | `https://kaliganjtravel.com` — reference থাকা নতুন app deploy হওয়ার প্রমাণ নয় |
| SMTP sender / reply-to | এখনো configure হয়নি; public email code-এ থাকা মানেই SMTP delivery setup নয় |
| Archive / BCC | অনির্ধারিত; unset থাকলে archive copy যাবে না |
| Admin SMS recipients | এখনো খালি; support phone স্বয়ংক্রিয়ভাবে recipient নয় |
| License number | দেওয়া হয়নি; database NULL, প্রয়োজনীয় UI-তে `--` |

Super Admin login email-কে স্বয়ংক্রিয়ভাবে sender/BCC/notification email ধরা যাবে না। কোনো secret এই নোটে রাখা হবে না।

## ৪. বাকি কাজ—স্টেপ বাই স্টেপ

### ধাপ ১ — নতুন Super Admin account চালু করা

**নির্ভরতা:** Owner-এর নিজের account verification। অন্য প্রস্তুতির কাজ এর সঙ্গে সমান্তরালে করা যায়।

- [ ] ব্যবহারকারী নতুন Clerk application-এ `kaliganjtravels@gmail.com` দিয়ে account তৈরি ও email verification করবেন। ১১ সেপ্টেম্বরের নতুন live exact-email lookup-এ account পাওয়া যায়নি।
- [ ] Signup verification-এর email delivery কাজ করছে কি না নিশ্চিত করতে হবে; SMTP প্রস্তুত না থাকলে কার্যকর Clerk-managed delivery রাখতে হবে। Verification বাদ দেওয়া যাবে না।
- [ ] Account পাওয়া গেলে সঠিক নতুন Clerk instance ও verified email মিলিয়ে `publicMetadata.role = "superadmin"` দিতে হবে।
- [ ] নতুন Clerk user ID-কে নতুন Supabase user registry-র সঙ্গে যুক্ত করতে হবে; কোনো পুরোনো user ID copy নয়।
- [ ] Normal login-এ Super Admin dashboard ও প্রয়োজনীয় controls যাচাই করতে হবে; dev role switcher দিয়ে নয়।

**Done হলে:** মালিক নিজের account দিয়ে প্রশাসনিক settings ব্যবহার করতে পারবেন।

### ধাপ ২ — Company ও business settings পূরণ করা

- [ ] বর্তমান public company details চূড়ান্ত কিনা নিশ্চিত; প্রকৃত license number পাওয়া গেলে source/database configuration-এ দিতে হবে।
- [ ] নতুন branch, company bank/MFS account, QR ও deposit receiver তৈরি করতে হবে—শুধু ব্যবহারকারীর দেওয়া নতুন কোম্পানির তথ্য দিয়ে।
- [ ] B2C/B2B markup, service fee ও supplier/user search limits নির্ধারণ করতে হবে।
- [ ] প্রয়োজনীয় নতুন staff/agency/role তৈরি করতে হবে; আগের user list বা balances import নয়।
- [ ] Wallet balance কোনো পুরোনো backup দিয়ে বসানো যাবে না; নতুন অনুমোদিত deposit/adjustment workflow ব্যবহার করতে হবে।

**Done হলে:** নতুন কোম্পানির operational/payment configuration প্রস্তুত থাকবে।

### ধাপ ৩ — Redis, Cloudinary ও Triplover যাচাই

- [x] Redis connection, isolated synthetic quote-like payload write/read এবং ২ সেকেন্ড TTL expiry পাস। Application quote-store workflow E2E ধাপ ৮-এ বাকি।
- [x] Configured Cloudinary account-এর `kaliganj-travels/verification` namespace-এ নতুন synthetic PNG upload/read পাস; unsigned private access 401, signed download 200, expired link 401। Test assets cleanup সফল। Account ownership/isolation ব্যবহারকারীর নতুন credentials দেওয়ার তথ্যের ভিত্তিতে; পুরোনো cloud inspect করা হয়নি।
- [ ] নতুন promotional artwork/offer/banner configure করতে হবে; inactive slots প্রস্তুত না হওয়া পর্যন্ত publish নয়।
- [x] Triplover credentials দিয়ে production client adapter-এর authentication, DAC–CXB (২৫ সেপ্টেম্বর ২০২৬) search ও একটি unambiguous offer-এর reprice পাস; price reference ও numeric price পাওয়া গেছে। Booking/issue/cancel করা হয়নি।
- [ ] Actual booking/issue/cancel পরীক্ষা ধাপ ৮-এ অনুমোদিত test ব্যবস্থা ও সঠিক financial settings দিয়ে করতে হবে।
- [ ] FirstTrip/TakeOff এখন অনির্বাচিত থাকবে; তাদের credentials এলে আলাদা verification হবে।

**Done হলে:** প্রাথমিক integration readiness নিশ্চিত হবে; credentials-কে শুধু উপস্থিতির ভিত্তিতে verified বলা হবে না।

### ধাপ ৪ — Email setup (credentials পরে পাওয়া যাবে)

- [ ] `.env.local`-এ `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS` দিতে হবে।
- [ ] `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO` ঠিক করতে হবে।
- [ ] Archive copy চাইলে নির্দিষ্ট `SYSTEM_EMAIL_BCC`; না চাইলে খালি রাখা যাবে।
- [ ] Sender/domain provider configuration ও SMTP authentication পরীক্ষা করতে হবে।
- [ ] অনুমোদিত test inbox-এ welcome, invitation, booking, deposit ও ticket-management email এবং PDF attachment পরীক্ষা করতে হবে।

**Done হলে:** নতুন কোম্পানির sender দিয়ে সঠিক recipient-এ email যাবে; পুরোনো কোম্পানি কোনো copy পাবে না।

### ধাপ ৫ — SMS setup (credentials পরে পাওয়া যাবে)

- [ ] `BULKSMSBD_API_KEY`, `BULKSMSBD_SENDER_ID`; প্রয়োজন হলে `BULKSMSBD_API_URL` দিতে হবে।
- [ ] ব্যবহারকারীর অনুমোদিত নতুন admin নম্বর `company_admin_sms_recipients`-এ configure করতে হবে।
- [ ] নির্দিষ্ট test number-এ issued-ticket, deposit-approved, deposit-request ও manual SMS পরীক্ষা করতে হবে।
- [ ] Sender ID, retry/duplicate protection এবং recipient selection যাচাই করতে হবে।

**Done হলে:** SMS ফিচার বাস্তবে কার্যকর হবে। API key না থাকলে এই ধাপ pending থাকবে; পুরোনো key/number দিয়ে পূরণ করা যাবে না।

### ধাপ ৬ — নতুন repository ও Vercel preview তৈরি

**নির্ভরতা:** নতুন repository name, hosting access ও domain সিদ্ধান্ত।

- [ ] নতুন Git repository তৈরি; secrets, local CLI state ও generated build output বাদ দিয়ে commit করতে হবে।
- [ ] নতুন GitHub repository connect করতে হবে; পুরোনো `babuas25/shopontravels` অপরিবর্তিত থাকবে।
- [ ] নতুন Vercel project connect; প্রয়োজনীয় environment variables সেখানে আলাদাভাবে দিতে হবে।
- [ ] Preview/test ও production environment-এর data/service সীমা নির্ধারণ করতে হবে।
- [ ] নতুন app origin অনুযায়ী `APP_URL`, Clerk allowed domain ও redirect settings মিলাতে হবে।
- [ ] Preview build/deployment, bundled assets/PDF এবং browser-backed IMP/EXP runtime পরীক্ষা করতে হবে।

**Done হলে:** নতুন app-এর একটি কার্যকর preview URL থাকবে; public production launch এখনো ধাপ ৯।

### ধাপ ৭ — Webhook, Vault ও scheduler

**নির্ভরতা:** কার্যকর নতুন deployment URL; সংশ্লিষ্ট notification services প্রস্তুত।

- [ ] নতুন Clerk endpoint: `/api/webhooks/clerk-email`; `email.created` ও `user.created` events এবং matching signing secret দিতে হবে।
- [ ] Clerk-delivered বনাম custom SMTP template mode মিলিয়ে duplicate/failed delivery পরীক্ষা করতে হবে।
- [ ] নতুন Supabase Vault-এ `booking_status_app_url`, `booking_status_cron_secret` বসাতে হবে; deployment-এর `CRON_SECRET`-এর সঙ্গে মিলতে হবে।
- [ ] Booking lifecycle/email/SMS dispatcher schedule প্রস্তুত ও পরীক্ষিত করতে হবে।
- [ ] Ticket-management quote-expiry schedule আলাদাভাবে configure করতে হবে।
- [ ] Lifecycle workers, notification outbox ও PNR-refresh flags প্রয়োজন অনুযায়ী enable করে তাদের কাজ যাচাই করতে হবে; সব flag একসঙ্গে অনুমান করে চালু নয়।

**Done হলে:** Background updates ও notifications নতুন app/database-এ চলবে।

### ধাপ ৮ — পুরো application workflow পরীক্ষা

**নির্ভরতা:** ধাপ ১–৭-এর সংশ্লিষ্ট configuration; নতুন test identities/data।

- [ ] Customer, B2B, sub-user, staff, admin ও Super Admin দিয়ে permission boundaries পরীক্ষা।
- [ ] Search → reprice → booking → issue/cancel; resume, deadline, PNR refresh ও reconciliation পরীক্ষা।
- [ ] Wallet deposit/approval/ledger/refund; ভুল actor ও duplicate request-এর financial safety পরীক্ষা।
- [ ] Ticket management refund/reissue/void ও settlement পরীক্ষা।
- [ ] IMP/EXP manual/supplier import, document upload, notification, sharing ও PDF/Excel reports পরীক্ষা।
- [ ] নতুন Git-independent pricing regression verification প্রস্তুত ও চালানো।
- [ ] Supplier-এর sandbox/test ব্যবস্থা ব্যবহার; বাস্তব paid ticket/financial action লাগলে নির্দিষ্ট test scope ও খরচ আগে ঠিক করতে হবে।
- [ ] Test records স্পষ্টভাবে চিহ্নিত থাকবে। Initial-empty checker পাস করানোর জন্য বাস্তব/audit records মুছে দেওয়া যাবে না।

**Done হলে:** পুরোনো সব ফিচার নতুন configuration-এ কাজ করছে—তার end-to-end প্রমাণ থাকবে।

### ধাপ ৯ — Production চালু করা

- [ ] প্রয়োজনীয় test ও unresolved issue review শেষ।
- [ ] সঠিক production domain/env, Clerk instance, supplier account ও notification recipients যাচাই।
- [ ] Booking ও ticketing database gates প্রস্তুতি অনুযায়ী সক্রিয় করা।
- [ ] Production deployment ও smoke test; error/worker/delivery monitoring চালু।
- [ ] Final launch checklist ও বাকি optional integrations নথিভুক্ত করা।

**Done হলে:** Kaliganj Travels operational হবে। FirstTrip/TakeOff পরে যোগ করা যাবে; প্রতিটির নিজস্ব verification প্রয়োজন।

## ৫. এখন সবচেয়ে আগে কী করতে হবে

1. **Owner account:** নতুন Clerk-এ `kaliganjtravels@gmail.com` account ও verification সম্পন্ন করা।
2. **Business information:** license থাকলে সেটি, নতুন payment/branch ও markup সিদ্ধান্ত দেওয়া।
3. **Integration verification:** Redis, Cloudinary ও Triplover যাচাই করা। Email/SMS credentials না আসা পর্যন্ত সেগুলো pending রাখা।

নতুন repository/deployment ও পূর্ণ workflow verification পরের ধাপে হবে। এই Markdown তৈরি মানে কোনো pending task execute, schedule বা স্বয়ংক্রিয় goal চালু করা নয়।

## ৬. কাজ চালানোর সময় গুরুত্বপূর্ণ নিয়ম ও রেফারেন্স

- নতুন database-এর migration workdir: **`supabase/fresh-install/`**। Root-এর legacy `supabase/migrations/` দিয়ে `db push` নয়।
- Applied baseline বদলানো যাবে না; সব পরবর্তী পরিবর্তন নতুন forward migration।
- Local disposable test: `npm run verify:fresh-database`।
- বর্তমান documented diagnostic-record state-এর hosted check: `npm run verify:hosted-database -- --post-setup`। বাস্তব onboarding/business data শুরু হলে এটি সাধারণ health check-এর বিকল্প নয়।
- Baseline receipt: [installation.json](supabase/fresh-install/installation.json) — baseline সময়ের snapshot; পরের contact migration-এর অবস্থা [rebranding report](docs/24-KALIGANJ-REBRANDING.md)-এ আছে।
- বিস্তারিত database setup: [fresh-install README](supabase/fresh-install/README.md)।
- বর্তমান branding ও verification record: [24-KALIGANJ-REBRANDING.md](docs/24-KALIGANJ-REBRANDING.md)।
- পুরোনো পর্যায়সহ বিস্তারিত audit: [23-NEW-COMPANY-MIGRATION-AUDIT.md](docs/23-NEW-COMPANY-MIGRATION-AUDIT.md)।

প্রতিটি ধাপ বাস্তবে শেষ হলে সংশ্লিষ্ট checkbox, verification date/result ও বাকি সীমাবদ্ধতা এই ফাইলে update করতে হবে।

## ৫. সর্বশেষ অগ্রগতি — ১১ সেপ্টেম্বর ২০২৬

- নতুন Clerk instance-এ owner email lookup: ০ account। Owner signup ও verified email প্রয়োজন; কোনো account/password বানানো হয়নি।
- Redis PING, isolated synthetic payload write/read, TTL ও expiry পাস; test key cleanup হয়েছে। এটি application quote ownership/selection workflow-এর পূর্ণ পরীক্ষা নয়।
- Cloudinary public PNG HTTP 200; authenticated PNG-এর প্রকৃত unsigned URL 401; time-limited private download 200; expired link 401। Upload response-এর secure URL-এ signature থাকে—সেটিকে unsigned ধরে পরীক্ষা করা হয়নি। তিনটি নতুন test asset মুছে দেওয়া হয়েছে।
- Hosted verification পুনরায় পাস: ৮২ table, ৩০৩ function, সব RLS, REST/RPC এবং anonymous settings denial। User/booking/wallet business tables খালি; booking/ticketing বন্ধ।
- এখন operational rows: search usage event ১, daily counter ১, security audit event ১, rate-limit bucket ২। Search event-এর timestamp 2026-09-11 11:23:56 UTC, outcome success, supplier Triplover। এগুলো মুছে দেওয়া হয়নি।
- `--post-setup` verifier এখন search usage/counter-ও আলাদাভাবে report করে; default strict empty-install check এবং business-table empty assertions অপরিবর্তিত।
- License, payment receiver/bank/MFS ও markup সিদ্ধান্ত; SMTP/SMS credentials; নতুন repository/hosting configuration এখনো প্রয়োজন।

- Triplover live adapter test: authentication/search পাস (প্রথম search-এ ১১ offer); দ্বিতীয় search থেকে একটি unambiguous selection reprice পাস, price reference ও finite price পাওয়া গেছে। কোনো booking/ticket/financial operation তৈরি করা হয়নি।

### Owner account update — 2026-09-11

- [x] Exactly one Clerk account matched kaliganjtravels@gmail.com; primary email verified and account active.
- [x] Clerk publicMetadata.role updated to superadmin and verified by reading the user again.
- [x] New Supabase app_users row synchronized to superadmin with no agency link; read-back passed.
- [ ] Browser login/dashboard verification remains pending. Refresh; an existing development View as Customer cookie can still override the preview.

Earlier account-not-found and empty-user-table statements are historical snapshots, superseded by this update. The fresh-install hosted verifier still expects an empty user registry; future operational checks must explicitly allow and verify this new owner identity. No old company account or business data was imported.

### Payment methods configured — 2026-09-11

- [x] Owner-specified source https://kaliganjtravel.com/ inspected; 11 bank accounts and 6 MFS accounts copied into the new project's payment settings. Exact captured values: `docs/setup/kaliganj-payment-methods.json`.
- [x] Forward migration `20260911020000_kaliganj_payment_methods.sql` applied only to Supabase `ljzoizsogbirlvlsrwzi`; installed baseline unchanged.
- [x] Multiple numbers per MFS provider/type supported with account-number selection in the deposit form. Duplicate provider/type/number combinations remain blocked.
- [x] Personal mapped to Send Money; Agent mapped to Cashout. Missing QR, SWIFT and branch codes left null. BRAC company account routing number absent on source, left null.
- [x] Hosted read-back exactly matches all 17 source records. Local migration/idempotency/duplicate-protection tests, TypeScript and targeted ESLint passed. Authenticated Super Admin account list verified in browser.
- [ ] Confirm any company MFS surcharge: current database default remains 0%; this does not promise zero provider fees.
- [ ] Bank account types (City Savings/Business Solution) preserved in source notes; current application has no bank account-type field.
- [ ] Logos/QR can be configured separately when supplied. No transfers, deposits, approvals, wallet credits or payment gateway connections were performed.

The earlier empty payment-table state is now superseded. These are newly configured receiving accounts from the owner's company website, not a migration of the previous project's financial history. Fresh-install-only hosted assertions are not an operational verifier after owner/payment configuration.

### Markup verification — 2026-09-11

No rules were changed. Confirmed two active percentage rules with no airline, route or agency restriction and LCC service margin disabled. Synthetic supplier payable BDT 10,000: B2B 10,100; B2C 10,400; Super Admin 10,000. Gross-cap cases also passed. SMTP and Bulk SMS required credentials remain absent; no message sent. The screenshot shows an incomplete airline-code warning in the new-rule form, but both saved all-airline rules are valid.

### Zoho SMTP verification — 2026-09-11

- [x] Local SMTP configuration and live Zoho connection/authentication passed: smtp.zoho.com, port 465, implicit TLS enabled, certificate verification enabled. Sender matches authenticated mailbox; Reply-To configured.
- [x] Password is present and is not the example placeholder; no secret recorded in this report.
- [ ] Actual message delivery, SPF/DKIM alignment and inbox/PDF attachment verification remain pending. No email was sent by this check; authentication does not verify recipient delivery or Reply-To mailbox existence.

This supersedes earlier missing-SMTP-credentials notes. Next email step: send a test message only to an explicitly authorized recipient, then check delivery.

### Authorized SMTP delivery test — 2026-09-11

- [x] One test email sent from noreply@kaliganjtravel.com to the explicitly authorized recipient kaliganjtravels@gmail.com. Subject: Kaliganj Travels — Email Setup Test.
- [x] Zoho SMTP accepted the recipient/message; zero rejected recipients. No CC/BCC or attachments. Message-ID: <9546730b-bdc2-53d0-1f20-088b4de76b26@kaliganjtravel.com>.
- [ ] Recipient inbox/spam arrival confirmation remains pending. SMTP acceptance is not proof of inbox delivery. Application notification/PDF delivery tests remain separate.

### Inbox confirmation and authentication issue — 2026-09-11

- [x] User screenshot confirms test message arrived in Gmail Inbox.
- [ ] Gmail warns that the message is not authenticated and sender cannot be verified. Delivery setup is not fully complete.
- Public DNS check: SPF is `v=spf1 ip4:136.243.82.43 ip4:178.63.26.50 +a +mx ~all` (no explicit Zoho include); DMARC exists as `v=DMARC1; p=none;`. Nameservers: zara.balancedserver.com, nova.balancedserver.com.
- Next: obtain account-specific SPF/DKIM values from Zoho Admin Console, merge SPF into the existing single record preserving other required senders, publish DKIM and verify/enable it in Zoho. DKIM state is not yet determined; message Authentication-Results headers have not been inspected. No DNS changes made.
