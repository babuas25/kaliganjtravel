# নতুন কোম্পানির জন্য প্রজেক্ট পুনর্ব্যবহার: যাচাই ও পরিবর্তনের নোট

যাচাইয়ের তারিখ: ১০ সেপ্টেম্বর ২০২৬।

সর্বশেষ env/configuration পুনঃযাচাই: ১১ সেপ্টেম্বর ২০২৬। নতুন ব্র্যান্ড: **Kaliganj Travels** (ব্যবহারকারীর দেওয়া বানান)।

## পূর্ণ application rebranding সম্পন্ন — ১১ সেপ্টেম্বর ২০২৬

ব্যবহারকারীর নির্দেশ অনুযায়ী `kaliganjtravel.com` থেকে লোগো, কমলা/গাঢ় নীল থিম ও প্রকাশিত যোগাযোগের তথ্য নিয়ে application rebranding করা হয়েছে। Customer-facing runtime-এ আগের কোম্পানির নাম, যোগাযোগ বা license fallback নেই। নতুন Supabase-এ forward migration দিয়ে company contact update হয়েছে। বিস্তারিত current state, verification এবং সীমাবদ্ধতা: `docs/24-KALIGANJ-REBRANDING.md`। নিচের অংশগুলো আগের পর্যায়ের ঐতিহাসিক রেকর্ড।

## Email archive ও asset namespace পরিবর্তন সম্পন্ন — ১১ সেপ্টেম্বর ২০২৬

পরবর্তী implementation ধাপে স্থানীয় application configuration পরিবর্তন করা হয়েছে:

- `lib/email/mailer.ts` থেকে পুরোনো hardcoded archive BCC সরানো হয়েছে। এখন `SYSTEM_EMAIL_BCC`-তে একটি valid address দিলে hidden copy যায়; unset/blank হলে কোনো archive copy যায় না। মূল recipient একই address হলে case-insensitive মিলিয়ে duplicate copy বাদ দেওয়া হয়। Invalid address হলে send বন্ধ থাকে।
- SMTP এখন শুধু `SMTP_PASSWORD` ব্যবহার করে; পুরোনো company-specific password key আর fallback নয়। Default sender name `Kaliganj Travels`; sender address ও credentials configure করা এখনো বাকি। `scripts/verify-email.mjs` generic password key ব্যবহার করে।
- Cloudinary-এর আটটি upload folder এবং marketing seed script-এর target এখন `kaliganj-travels/...`; fixed site logo নতুন `kaliganj-travels/site/logo` path ব্যবহার করবে। কোনো asset upload, move, delete বা seed চালানো হয়নি। Folder separation account-level isolation-এর বিকল্প নয়; নতুন cloud credentials যাচাই এখনো বাকি।
- `.env.example`-এ নতুন SMTP/archive ও Cloudinary configuration template যোগ করা হয়েছে। `.env.local` পরিবর্তন করা হয়নি; owner login email-কে archive recipient হিসেবে ধরে নেওয়া হয়নি।
- যাচাই পাস: `verify:booking-notification-hidden-bcc` (mock SMTP-তে missing/blank/valid/invalid BCC, duplicate suppression, generic password ও sender name), `verify:booking-email`, `typecheck`, পরিবর্তিত JS/TS ফাইলের ESLint। কোনো real email/SMS বা external service call করা হয়নি।

পরবর্তী কাজ: পূর্ণ UI/email/PDF branding ও supplier booking contact configuration; প্রকৃত company contact/license তথ্য এবং নতুন Clerk owner account setup। নিচের পুরোনো audit-এর BCC, SMTP password ও Cloudinary folder findings এই ধাপে সমাধান হয়েছে; অন্য checklist items এখনো স্বতন্ত্রভাবে বাকি।

## Hosted database installation সম্পন্ন — ১১ সেপ্টেম্বর ২০২৬

ব্যবহারকারীর “continue please” নির্দেশ অনুযায়ী নতুন Supabase project `ljzoizsogbirlvlsrwzi`-এ baseline install করা হয়েছে। নিচের আগের preparation/audit অংশগুলো পূর্ববর্তী পর্যায়ের রেকর্ড; বর্তমান অবস্থা এই অংশে।

- Install-এর আগে hosted project-এ public application table/view সংখ্যা **শূন্য** ছিল।
- Fresh-install workdir নতুন project-এ link করে dry run-এ শুধু `20260911000000_kaliganj_baseline.sql` নিশ্চিত করা হয়েছে। কোনো seed/backup restore করা হয়নি।
- Hosted migration সফল। পুনরায় dry run: **up to date**, কোনো pending migration/seed নেই।
- Hosted verification: **৮২টি table, ৩০৩টি public function**, সব table-এ RLS; সব business-data table খালি। শুধু আগের নোটে তালিকাভুক্ত নতুন installation settings ও inactive editor slots আছে।
- আটটি REST check ও read-only lifecycle RPC পাস। Anonymous client নতুন company settings পড়তে পারে না।
- Company name Kaliganj Travels; অজানা phone/email/address/license খালি। SMS recipient নেই। Triplover selected, booking/ticketing বন্ধ।
- `SUPABASE_DB_PASSWORD` ও `DATABASE_URL`-এর password অমিল ছিল। `DATABASE_URL`-এর password দিয়ে hosted authentication সফল হওয়ার পরে শুধু স্থানীয় `SUPABASE_DB_PASSWORD` মিলিয়ে দেওয়া হয়েছে; remote password বদলানো হয়নি। নতুন env দিয়েও CLI dry run সফল।
- কোনো পুরোনো project/repository/database/service account থেকে data পড়া বা import করা হয়নি। কোনো real booking, wallet transaction, email বা SMS তৈরি করা হয়নি।
- প্রমাণ: `supabase/fresh-install/installation.json`; read-only checker: `npm run verify:hosted-database`। Checkerটি নতুন, অব্যবহৃত database-এর empty-state যাচাই করে; বাস্তব user/data শুরু হলে সেই পরীক্ষা আর প্রযোজ্য হবে না।
- Applied baseline এখন frozen; preparation generator সেটি overwrite করতে অস্বীকার করবে। পরবর্তী database পরিবর্তন fresh-install workdir-এ নতুন forward migration হিসেবে করতে হবে।

এখনো বাকি: নতুন Super Admin email/Clerk account নির্ধারণ, প্রকৃত company information, payment/markup configuration, application rebranding ও পুরোনো BCC/supplier contact অপসারণ, প্রয়োজনীয় service credentials, cron/Vault এবং পুরো application workflow verification। Super Admin email ও company information ব্যবহারকারীর কাছে চাওয়া হয়েছে; তা অনুমান করে বসানো হয়নি।

## অনুমোদিত database preparation সম্পন্ন — ১১ সেপ্টেম্বর ২০২৬

ব্যবহারকারী database preparation শুরু করার অনুমতি দিয়েছেন এবং পুরোনো কোনো data না আনার শর্ত পুনরায় নিশ্চিত করেছেন। সেই অনুযায়ী আলাদা fresh-install baseline প্রস্তুত ও স্থানীয় খালি PGlite database-এ যাচাই করা হয়েছে। **Hosted Supabase-এ এখনো apply করা হয়নি।** নিচের আগের audit-এর “কোনো code পরিবর্তন নয়” কথাগুলো সেই audit পর্যায়ের অবস্থা; এই নতুন অনুমোদিত কাজে preparation scripts, generated SQL ও নোট যোগ করা হয়েছে।

- নতুন CLI workdir: `supabase/fresh-install/`; মূল `supabase/migrations/` অপরিবর্তিত। নতুন installation-এর migration history আলাদা থাকবে।
- Generated baseline: `supabase/fresh-install/supabase/migrations/20260911000000_kaliganj_baseline.sql`। ১৫৯টি source migration-এর checksum ও পরিবর্তনের তালিকা একই directory-এর `manifest.json`-এ আছে।
- মূল Supabase CLI link আবার পড়ে নিশ্চিত করা হয়েছে: নতুন project `ljzoizsogbirlvlsrwzi`-এর সঙ্গে মিলে। Fresh-install workdir-এর link আলাদা; সেটি এখনো করা হয়নি।
- `0034`-এর functions রেখে পুরোনো booking repair বাদ; `0036`/`0039`-এর booking-only repair ও `0035`-এর পুরোনো email error update বাদ। বিস্তারিত পরীক্ষায় `0039`-ও খালি database-এ ব্যর্থ হওয়ার বাধা হিসেবে নিশ্চিত হয়েছে।
- পুরোনো branch, announcement এবং offer content বাদ। নতুন offer editor চালু রাখার জন্য নতুন UUID-সহ তিনটি inactive placeholder slot রাখা হয়েছে; কোনো পুরোনো offer/image নেই।
- নতুন `company_settings`-এ শুধু Kaliganj Travels নাম; address/phone/email/license খালি। SQL notification snapshot এই settings ব্যবহার করে।
- নতুন `company_admin_sms_recipients` খালি; পুরোনো দুইটি নম্বর নেই। নতুন recipient পরে configure করতে হবে।
- Triplover selected, database booking/ticketing gates বন্ধ। Setup ও পরীক্ষা শেষ হলে সক্রিয় হবে।
- Cron/Vault deployment পিছিয়ে রাখা হয়েছে; baseline কোনো background request চালু করে না।
- **Test passed:** ৮২টি public table; শুধু সাতটি settings/editor table-এ অনুমোদিত নতুন row; বাকি সব table খালি। Users, bookings, wallets/ledger, documents, payment accounts, notification queue ও পুরোনো history নেই।
- RLS সব table-এ যাচাই; একটি legacy table-এর missing RLS fresh baseline-এ যোগ করা হয়েছে। Existing schema-এ পুনরায় চালালে install প্রত্যাখ্যান করে।
- নতুন synthetic test record দিয়ে SMS recipient selection, wallet balance অপরিবর্তিত থাকা এবং immutable company snapshot পরীক্ষা করা হয়েছে। এসব record কেবল disposable test database-এ; baseline artifact-এ নেই।
- Commands: `npm run db:prepare-fresh`, `npm run verify:fresh-database`। Hosted application, service credentials বা পূর্ণ end-to-end feature পরীক্ষা এখনো বাকি।

পরবর্তী hosted installation-এর নিয়ম ও বাকি কাজ: `supabase/fresh-install/README.md`। Root directory থেকে পুরোনো migration chain দিয়ে `db push` করা যাবে না। Application-এর পুরোনো branding, BCC ও supplier contact এখনো আলাদা rebranding কাজ হিসেবে বাকি আছে।

## সর্বশেষ অবস্থা: Kaliganj Travels-এর প্রস্তুতি

নিচের ফল স্থানীয় `.env.local` ও source inspection থেকে পাওয়া। কোনো secret প্রকাশ, service login, network credential test, database query/migration বা deployment করা হয়নি। `SET` মানে ফাইলে non-empty value আছে; credential কার্যকর বা service setup সম্পূর্ণ—এটি বোঝায় না।

| সার্ভিস/সেটিং | বর্তমান অবস্থা | পরবর্তী কাজ |
|---|---|---|
| Clerk | Publishable key, secret key ও webhook signing secret আছে; key environment মেলে, webhook secret-এর prefix প্রত্যাশিত | নতুন application/domain, webhook endpoint/events ও superadmin setup যাচাই; একই environment হওয়া একই application হওয়ার প্রমাণ নয় |
| Supabase | URL, service-role/anon key, DB URL/password আছে। দুই JWT-এর project ref/role এবং DB URL-এর target নতুন Supabase URL-এর সঙ্গে মেলে | Authentication ও schema এখনো যাচাই হয়নি; clean-install bootstrap প্রয়োজন |
| Supabase CLI link | `supabase/.temp/project-ref` env-এর project reference-এর সঙ্গে **মেলে না** | নতুন project-এ relink করতে হবে; relink হওয়ার আগে `--linked` migration command চালানো যাবে না |
| Redis | URL আছে; quote store `redis` নির্বাচিত | নতুন instance-এর connectivity ও quote persistence পরে পরীক্ষা |
| Cloudinary | Cloud name, key, secret আছে | নতুন cloud-এ folder namespace/logo/media setup ও access যাচাই |
| Triplover | Search/API URL, email ও password আছে | Active supplier স্পষ্টভাবে `triplover` করতে হবে; পরে provider authentication/feature verification |
| FirstTrip / TakeOff | `.env.local`-এ credentials নেই; ব্যবহারকারী পরে দেবেন | Integration code রাখা হবে; এখন এই accounts active করা হবে না |
| Email | SMTP ও sender settings নেই; ব্যবহারকারী পরে দেবেন | Custom email/Clerk SMTP relay তখন পর্যন্ত কাজ করবে না; পুরোনো BCC/contact সরিয়ে নতুন configuration প্রস্তুত করতে হবে |
| Bulk SMS | API key/sender settings নেই; ব্যবহারকারী পরে দেবেন | SMS delivery তখন পর্যন্ত কাজ করবে না; SQL admin recipients নতুন করে দিতে হবে |
| App URL | HTTPS origin আছে; local URL নয় এবং পুরোনো brand string নেই | নতুন domain সত্যিই deploy/reachable কি না এবং webhook/links সঠিক কি না পরে যাচাই |
| Cron | `CRON_SECRET` আছে | নতুন database-এর Vault secrets ও scheduler এখনো যাচাই হয়নি |
| Vercel OIDC token | `.env.local`-এ নেই; বর্তমান app/lib/scripts/Next config/CI-তে সরাসরি ব্যবহার পাওয়া যায়নি | এই codebase-এর local setup-এর জন্য এখন এটি missing requirement নয়; ভবিষ্যৎ deployment tooling চাইলে নিজস্ব authentication flow ব্যবহার করবে |

### শুধু Triplover দিয়ে শুরু করার প্রয়োজনীয় সংশোধন

`lib/db/supplier-controls.ts`-এ settings row/table অনুপস্থিত থাকলে legacy fallback ব্যবহার হয়। `TRIPLOVER_ACTIVE_SUPPLIER` env-এ নেই এবং fallback হলো `takeoff`। ফলে শুধু `TRIPLOVER_*` credentials বসানো active supplier নির্বাচন করে না।

নতুন schema প্রস্তুত হলে Dashboard → Supplier Control-এর database setting-এ `triplover` নির্বাচন করতে হবে। Bootstrap-এর আগে legacy fallback প্রয়োজন হলে `TRIPLOVER_ACTIVE_SUPPLIER=triplover` সেট করা যায়; database setting তৈরি হলে সেটিই অগ্রাধিকার পায়। কোনো সেটিং এই audit-এ বদলানো হয়নি।

বর্তমানে `TRIPLOVER_BOOKING_ENABLED`, `TRIPLOVER_TICKETING_ENABLED`, `BOOKING_RECONCILIATION_ACTIONS_ENABLED`, `TICKET_MANAGEMENT_ENABLED`-এর env value `true`। এগুলো প্রস্তুতি/অনুমতির switch; নতুন database, account বা workflow কার্যকর হওয়ার প্রমাণ নয়। অন্য lifecycle worker/outbox/PNR flags `.env.local`-এ অনুপস্থিত; পুরো feature parity-এর জন্য পরে সেগুলোও পরিকল্পনা অনুযায়ী সেট করতে হবে।

### এখন যে কাজগুলো করতে হবে

1. **নতুন database bootstrap:** পুরোনো booking-specific repair থেকে প্রয়োজনীয় schema/function আলাদা করে fresh-install path তৈরি ও পরীক্ষা; নতুন Supabase target নিশ্চিত করে relink। পুরোনো data import নয়।
2. **Branding ও company configuration:** Shapon Travels-এর জায়গায় Kaliganj Travels, নতুন যোগাযোগ, license, logo/palette, footer/SEO, booking/PDF/Excel/email identity। এখনো পুরোনো hardcoded brand আছে।
3. **Operational contact:** Supplier booking email/phone, system BCC, database snapshot company details এবং admin SMS recipients নতুন করতে হবে। Email/SMS credentials পরে এলেও এই পুরোনো recipients রাখা যাবে না।
4. **Asset isolation:** Cloudinary-র `shapon/...` folders ও fixed logo target নতুন namespace-এ; নতুন logo ও marketing content setup।
5. **প্রথম চালু configuration:** নতুন Clerk admin/roles, active Triplover, নতুন markup/payment settings, Redis এবং প্রয়োজনীয় flags। Email/SMS ছাড়া পূর্ণ feature verification সম্পন্ন বলা যাবে না।
6. **পরে সম্পূর্ণ করা:** Email/SMS credentials, Clerk delivery setup, FirstTrip/TakeOff accounts, cron/Vault, নতুন repository/Vercel deployment ও সব ফিচারের acceptance checks।

বাকি brand তথ্য: display name-এর সংক্ষিপ্ত/আইনি রূপ, logo, colour preference, address, phone/WhatsApp, public/support ও supplier booking email, license, Facebook এবং ভবিষ্যৎ archive email/admin SMS recipients। Credentials আবার পাঠানোর প্রয়োজন নেই।

নিচের মূল audit-এর checkbox-গুলো কাজের তালিকা। উপরের টেবিলে credential উপস্থিতির সর্বশেষ অবস্থা দেওয়া হয়েছে; credential উপস্থিতিকে live integration verified হিসেবে চিহ্নিত করা হয়নি।

## সিদ্ধান্ত ও কাজের সীমা

আগের সব ফিচারের কোড রেখে নতুন কোম্পানির জন্য আলাদা প্রজেক্ট করা সম্ভব। কিন্তু শুধু `.env` credentials ও লোগো বদলানো যথেষ্ট নয়। অ্যাপের কোড, database functions/seed data এবং বাইরের সার্ভিসের configuration—তিন জায়গাতেই পরিবর্তন লাগবে।

এই পর্যায়ে শুধু স্থানীয় source/configuration/migration পড়া হয়েছে এবং এই নোট তৈরি করা হয়েছে। কোনো application code, credential, database, service configuration, GitHub repository বা deployment পরিবর্তন করা হয়নি। কোনো live supplier call, booking, email বা SMS পাঠানো হয়নি। Secret-এর value এই নোটে রাখা হয়নি।

নতুন কোম্পানির নাম Kaliganj Travels। ব্যবহারকারী কিছু service-এর নতুন credentials স্থানীয় env-এ দিয়েছেন; সর্বশেষ অবস্থা উপরে আছে। ব্যবহারকারী নিশ্চিত করেছেন: নতুন database-এ পুরোনো কোনো data থাকবে না; সব service নতুন করে শুরু হবে, কিন্তু আগের সব feature ও কাজের নিয়ম একই থাকবে। এটি পুরোনো data স্থানান্তরের কাজ নয়, নতুন কোম্পানির জন্য স্বতন্ত্র installation।

### নিশ্চিত করা শর্ত

- পুরোনো user/customer, agency/staff, booking/passenger, wallet/ledger/balance, uploaded document/media, notification history/queue, cache বা পুরোনো company configuration import করা হবে না।
- Supabase, Clerk, email, Vercel, Cloudinary, Redis, SMS ও supplier integration নতুন কোম্পানির নিজস্ব setup/credentials ব্যবহার করবে। Provider ও integration-এর ধরন একই রাখা যাবে।
- “খালি database” বলতে পুরোনো business data থাকবে না। অ্যাপ চালানোর জন্য প্রয়োজনীয় tables, views, functions, triggers, permissions এবং নতুন installation-এর আবশ্যক reference/default settings তৈরি করতে হবে। নতুন admin ও company settings-ও নতুন করে setup হবে।
- পুরোনো booking নির্ভর এককালীন data-repair migration নতুন installation-এ প্রয়োগের প্রয়োজন নেই; তবে একই ফাইলে থাকা প্রয়োজনীয় schema/function changes সংরক্ষণ করতে হবে। সম্পূর্ণ fresh-install path খালি database-এ পরীক্ষা করে নিশ্চিত করতে হবে।
- পুরোনো কোম্পানির database, service accounts, deployment ও GitHub repository অপরিবর্তিত থাকবে।
- এই সিদ্ধান্ত নোট ও ভবিষ্যৎ implementation-এর scope নিশ্চিত করছে; এখনই code/service setup বা পরিবর্তন শুরু করার অনুমতি হিসেবে ধরা হয়নি।

## ১. সবচেয়ে গুরুত্বপূর্ণ যাচাইকৃত বিষয়

| অগ্রাধিকার | পাওয়া বিষয় | কী পরিবর্তন লাগবে | প্রমাণের ফাইল |
|---|---|---|---|
| আগে সমাধান | প্রতিটি system email-এর জন্য পুরোনো কোম্পানির hardcoded BCC আছে | নতুন কোম্পানির অনুমোদিত archive recipient বসাতে হবে; sender credentials বদলালেও BCC নিজে বদলাবে না | `lib/email/mailer.ts`, `SYSTEM_EMAIL_BCC` |
| আগে সমাধান | Supplier booking-এ পুরোনো কোম্পানির email ও phone পাঠানো হয় | নতুন supplier-facing email, phone ও country code বসাতে হবে | `lib/flights/booking.ts`, `BOOKING_CONTACT_DEFAULTS`; `lib/triplover/book.ts`, `SUPPLIER_BOOKING_CONTACT` |
| আগে সমাধান | Deposit request admin SMS-এর দুইটি recipient database trigger-এ নির্দিষ্ট করা আছে | নতুন notification recipient বসাতে হবে; শুধু SMS API key বদলালে recipient বদলাবে না | `supabase/migrations/0153_deposit_request_admin_sms.sql`, `foreach v_number` |
| আগে সমাধান | নতুন খালি database-এ পুরোনো migration chain সরাসরি চলার বাধা আছে | Clean installation-এর জন্য schema/bootstrap plan প্রস্তুত ও পরীক্ষা করতে হবে | migration `0034`, `0036`, `0042`; বিস্তারিত নিচে |
| প্রয়োজনীয় | Booking header ও database email snapshot-এ পুরোনো নাম, license, contact আছে | অ্যাপ ও SQL function দুই জায়গাতেই নতুন তথ্য বসাতে হবে | `lib/db/flight-bookings.ts`, `B2C_HEADER_CONTACT`; migration `0073` |
| প্রয়োজনীয় | Cloudinary-তে `shapon/...` folder ও fixed logo ID ব্যবহৃত হয় | নতুন product environment/cloud এবং কোম্পানির folder namespace ঠিক করতে হবে | `lib/cloudinary.ts`, `lib/appearance.ts`, `scripts/seed-marketing.mjs` |
| প্রয়োজনীয় | Git metadata নেই, কিন্তু অন্য service-এর local state রয়ে গেছে | নতুন সেটআপের সময় environment ও local service link আলাদা করতে হবে | `.env.local`, `.env.development.local`, `.clerk/`, `supabase/.temp/` |

## ২. একই ফিচার রাখতে যে অংশগুলো সংরক্ষণ করতে হবে

কোডে নিচের feature families পাওয়া গেছে। এটি উপস্থিতির যাচাই; live production-এ সবগুলো enabled বা কার্যকর আছে—এমন দাবি নয়।

- Flight search, filters, fare rules, repricing, checkout, booking, issue/cancel ও booking resume।
- FirstTrip, TakeOff ও direct Triplover supplier account selection; supplier/search controls।
- Customer, B2B, sub-user, admin, superadmin ও staff permissions; invitations, upgrade, profile ও document upload।
- Wallet, deposit/approval, bank ও MFS payment options, ledger, adjustment, refund ও reports।
- Booking lifecycle, time limit, PNR refresh, reconciliation, manual decisions ও notification outbox।
- IMP/EXP manual import, supplier-reference import ও direct airline retrieval।
- Ticket management: refund/reissue/void, assignment, settlement, notification ও quote expiry।
- Transactional email, Clerk email relay, issued-ticket/deposit SMS এবং manual SMS share।
- Logo/appearance, announcements, homepage offers, promotional popup, flight-search background ও marketing pages।
- Itinerary/booking sharing, ticket PDF ও PDF/Excel sales report।

সব ফিচার বজায় রাখতে শুধু UI নয়, database RPC/view/trigger, permissions, cron workers, feature flags ও service settings-ও নতুন environment-এ পুনঃস্থাপন করতে হবে।

## ৩. Database / Supabase

### নতুন project ও connection

- [ ] নতুন কোম্পানির জন্য আলাদা Supabase project/database তৈরি করতে হবে। একই database-এ শুধু নতুন password দেওয়া data separation নয়।
- [ ] নতুন `NEXT_PUBLIC_SUPABASE_URL` ও `SUPABASE_SERVICE_ROLE_KEY` বসাতে হবে; এগুলো application runtime-এ ব্যবহৃত হয় (`lib/supabase/server.ts`)।
- [ ] `DATABASE_URL`, `SUPABASE_DB_PASSWORD`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` থাকলে নতুন project অনুযায়ী দিতে হবে। কিছু verification/tooling anon key ব্যবহার করে; সব env runtime-এর সরাসরি dependency নয়।
- [ ] `supabase/.temp/`-এর পুরোনো CLI link নতুন project-এ relink করতে হবে। বর্তমানে directory আছে; কোনো link পরিবর্তন করা হয়নি।
- [ ] Tables, indexes, views, functions, triggers, RLS ও grants একই feature contract অনুযায়ী প্রস্তুত করতে হবে।

### নতুন database bootstrap-এর বাস্তব বাধা

স্থানীয়ভাবে **১৫৯টি SQL migration file** আছে; filename range `0001`–`0160`।

1. `0034_fix_pnr_dd_mm_deadline_and_hold_email.sql` একটি নির্দিষ্ট পুরোনো booking খোঁজে; না পেলে `raise exception` করে। এই ফাইলে feature-related function পরিবর্তনও আছে, তাই পুরো ফাইল নির্বিচারে বাদ দেওয়া ঠিক হবে না।
2. `0036_correct_ambiguous_pnr_deadline_by_booking_time.sql` আরেকটি নির্দিষ্ট পুরোনো booking না পেলে `raise exception` করে।
3. `0042_supabase_booking_status_email_cron.sql` চালাতে `pg_cron`, `pg_net` এবং Vault-এর `booking_status_app_url`, `booking_status_cron_secret` প্রয়োজন। Secrets না থাকলে migration বন্ধ হয়।
4. অন্যান্য historical data repair/backfill-ও খালি database-এর উপযোগিতা যাচাই করতে হবে। `0035`, `0039`-এও পুরোনো booking reference আছে; তাদের উপস্থিতি নিজে থেকে failure প্রমাণ নয়।

পরবর্তী implementation-এ নতুন কোম্পানির জন্য clean schema baseline অথবা reviewed fresh-install migration path তৈরি করতে হবে। পুরোনো কোম্পানির applied database migration/history পরিবর্তন না করে নতুন project-এ schema changes ও এককালীন পুরোনো data repair আলাদা করতে হবে। বাধা এড়াতে fake পুরোনো booking তৈরি করা যাবে না। সম্পূর্ণ clean install test না হওয়া পর্যন্ত bootstrap verified ধরা যাবে না।

### Database-এর ভেতরের company data

- [ ] `0023_deposit_channels.sql`-এর পুরোনো branch/address seed নতুন কোম্পানির জন্য বদলাতে হবে।
- [ ] `0073_booking_notification_render_snapshot.sql`-এর `enrich_booking_notification_snapshot_v1()`-এ company name, license number ও contact defaults বদলাতে হবে। B2B fallback-ও এখানে পুরোনো কোম্পানির।
- [ ] `0153_deposit_request_admin_sms.sql`-এর admin recipients নতুন করে নির্ধারণ করতে হবে।
- [ ] নতুন company bank accounts, MFS accounts/QR, payment branches, receivers ও opening setup তৈরি করতে হবে।
- [ ] নতুন markup rules, supplier settings, search limits, staff/agency configuration ও marketing records প্রয়োজনমতো সেট করতে হবে।
- [ ] পুরোনো customer/passenger, wallet balance, ledger, receipt, document, booking token বা notification outbox কপি করা যাবে না—সেগুলো আলাদা data-migration scope।

## ৪. Clerk / authentication

- [ ] নতুন Clerk application ও তার development/production credentials সেট করতে হবে: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`।
- [ ] নতুন domain/origin, sign-in/sign-up, invitation ও social-login settings পুনঃস্থাপন করতে হবে। অ্যাপের route defaults `/sign-in`, `/sign-up`, `/dashboard`; `app/layout.tsx` ও `lib/app-url.ts` দেখতে হবে।
- [ ] নতুন webhook endpoint হবে নতুন origin-এর `/api/webhooks/clerk-email`; handler `email.created` ও `user.created` গ্রহণ করে।
- [ ] Clerk-এর email template branding ও delivery mode মিলাতে হবে। `delivered_by_clerk` সত্য হলে relay এড়িয়ে যায়; custom SMTP delivery চাইলে সংশ্লিষ্ট dashboard setting-ও ঠিক করতে হবে।
- [ ] নতুন owner account-এর `publicMetadata.role` দিয়ে প্রকৃত `superadmin` setup করতে হবে; নতুন Clerk IDs অনুযায়ী database user/profile ও agency সম্পর্ক তৈরি হবে।
- [ ] Dev role-switcher-কে production admin setup ধরে নেওয়া যাবে না; production role Clerk metadata থেকে আসে (`lib/dashboard/session.ts`)।
- [ ] `.clerk/` local configuration নতুন application-এর জন্য পুনঃস্থাপন করতে হবে।

## ৫. Email / SMTP

- [ ] নতুন sender, reply-to ও credentials: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`।
- [ ] কোডে বর্তমানে `SHAPON_TRAVELS_SMTP_PASSWORD` প্রথমে পড়ে, এরপর `SMTP_PASSWORD` fallback। নতুন generic key ব্যবহার করলে পুরোনো key environment-এ রেখে দেওয়া যাবে না; সেটি precedence পাবে।
- [ ] `SYSTEM_EMAIL_BCC` নতুন archive address/configuration-এ নিতে হবে।
- [ ] Email subjects, welcome text, signatures, address, phone, website/social links ও inline styles বদলাতে হবে: `lib/email/templates.ts`, `lib/email/booking-template.ts`।
- [ ] `Message-ID`-এর পুরোনো domain বদলাতে হবে: `lib/email/notifications.ts`, `lib/email/ticket-management-delivery.ts`, `app/api/webhooks/clerk-email/route.ts`।
- [ ] `cid:shapon-*` internal image identifiers বদলালে attachment CID-ও একই সঙ্গে বদলাতে হবে; না হলে email icon ভাঙবে।
- [ ] Booking header ও SQL snapshot-এর branding-ও মিলতে হবে; শুধু HTML template বদলানো যথেষ্ট নয়।
- [ ] নতুন sender domain-এর mail-provider/DNS setup যাচাই এবং পরবর্তী অনুমোদিত test recipient-এ delivery পরীক্ষা করতে হবে।

`EMAIL_CONFIRMATION_SECRET` local env-এ আছে, কিন্তু বর্তমান app/lib/scripts scan-এ ব্যবহার পাওয়া যায়নি। নতুন project-এ প্রয়োজন যাচাই ছাড়া copy করা উচিত নয়।

## ৬. Cloudinary / logo / media

- [ ] আলাদা cloud/product environment-এর `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` দিতে হবে। একই cloud-এর শুধু নতুন API key asset isolation নিশ্চিত করে না।
- [ ] `lib/cloudinary.ts`-এর `FOLDERS` নতুন namespace-এ নিতে হবে: site, marketing, business docs, upgrade docs, wallet deposit receipts, bank/MFS logos ও QR।
- [ ] Logo fixed ID: `${FOLDERS.site}/logo` (`lib/appearance.ts`)। একই cloud ও ID ব্যবহার করলে নতুন upload পুরোনো logo overwrite করতে পারে।
- [ ] Dashboard → Appearance দিয়ে নতুন logo upload করা যাবে। সেই logo favicon/apple icon হিসেবেও ব্যবহৃত হয় (`app/layout.tsx`)।
- [ ] `scripts/seed-marketing.mjs`-এ hardcoded `shapon/marketing` বদলাতে হবে; নতুন target নিশ্চিত করার পরে প্রয়োজনে seed চালাতে হবে।
- [ ] নতুন offers/banner/popup/search background সেট করতে হবে; পুরোনো database asset URLs/public IDs কপি করলে নতুন cloud credentials দিয়েই ছবি স্থানান্তর হয়ে যাবে না।
- [ ] Business document-এর authenticated upload ও private download আচরণ বজায় রেখে নতুন environment-এ পরীক্ষা করতে হবে।

## ৭. Supplier / booking যোগাযোগ

একই integration code রাখা যাবে। সমর্থিত credential account তিনটি: `firsttrip`, `takeoff`, `triplover`।

প্রতিটির configuration pattern:

```text
FIRSTTRIP_SEARCH_BASE_URL / FIRSTTRIP_BASE_URL / FIRSTTRIP_EMAIL / FIRSTTRIP_PASSWORD
TAKEOFF_SEARCH_BASE_URL / TAKEOFF_BASE_URL / TAKEOFF_EMAIL / TAKEOFF_PASSWORD
TRIPLOVER_SEARCH_BASE_URL / TRIPLOVER_BASE_URL / TRIPLOVER_EMAIL / TRIPLOVER_PASSWORD
```

- [ ] নতুন partner credentials নিতে হবে। Endpoint একই থাকলে তা রেখে দেওয়া যায়, তবে নতুন account-এর জন্য supplier-confirmed URL ব্যবহার করতে হবে। Search ও booking URL এক ধরে নেওয়া যাবে না।
- [ ] Adapter provider-supplied encoded password সরাসরি পাঠায়; প্রয়োজন ছাড়া আবার encode করা যাবে না (`lib/triplover/config.ts`)।
- [ ] `BOOKING_CONTACT_DEFAULTS` এবং `SUPPLIER_BOOKING_CONTACT` নতুন company email/phone-এ বদলাতে হবে।
- [ ] Dashboard → Supplier Control-এ active supplier, booking ও ticketing gates সেট করতে হবে। Database settings থাকলে সেটিই কার্যকর; legacy env flag একা পুরো configuration নয় (`lib/db/supplier-controls.ts`)।
- [ ] Search limits, markup, account balance ও booking/ticketing permission নতুন account-এর জন্য যাচাই করতে হবে।
- [ ] IMP/EXP-এর direct airline retrieval বজায় রাখতে `lib/impexp/chrome.server.ts`, `next.config.js`-এর serverless Chromium dependencies/tracing রাখতে হবে। `CHROME_EXECUTABLE_PATH`, `CHROMIUM_PACK_URL`, airline URL overrides কেবল প্রয়োজন হলে নতুন environment অনুযায়ী সেট করতে হবে।

এই audit-এ supplier login, balance, permission বা booking success পরীক্ষা করা হয়নি।

## ৮. Redis, SMS ও background workers

### Redis

- [ ] আলাদা Redis database/instance ও `REDIS_URL` ব্যবহার করতে হবে। Source-এ quote prefix `flight:quote:v4:` আছে (`lib/flights/search-cache.ts`); company identifier দিয়ে partition করা নেই।
- [ ] `FLIGHT_QUOTE_STORE`, `FLIGHT_QUOTE_TTL_SECONDS`, `FLIGHT_QUOTE_MAX_BYTES` আগের প্রয়োজন অনুযায়ী পুনঃস্থাপন করতে হবে। পুরোনো quote/token cache কপি করা উচিত নয়।

### SMS

- [ ] নতুন `BULKSMSBD_API_KEY`, `BULKSMSBD_SENDER_ID`; প্রয়োজনে provider URL `BULKSMSBD_API_URL` সেট করতে হবে।
- [ ] `lib/sms/`-এর message generation ও database recipient configuration পরীক্ষা করতে হবে। বিশেষ করে migration `0153`-এর recipient পরিবর্তন ছাড়া admin SMS পুরোনো নম্বরে যাবে।
- [ ] Issued ticket, deposit approved, deposit-request admin ও manual SMS flow নতুন পরীক্ষামূলক recipient দিয়ে পরে যাচাই করতে হবে।

### Cron / feature parity

- [ ] নতুন `CRON_SECRET` এবং নতুন Supabase Vault-এর `booking_status_app_url`, `booking_status_cron_secret` একই নতুন deployment অনুযায়ী সেট করতে হবে।
- [ ] Migration `0042` ১৫ মিনিট পরপর `/api/cron/booking-status-emails` call করার schedule তৈরি করে। Routeটি booking lifecycle-এর পাশাপাশি email/SMS dispatch-ও করে।
- [ ] `/api/cron/ticket-management` quote expiry endpoint-এর scheduler আলাদাভাবে যাচাই/স্থাপন করতে হবে। এই endpoint-এর schedule স্থানীয় migration/config scan-এ পাওয়া যায়নি; live scheduler setup পরীক্ষা করা হয়নি।
- [ ] পুরোনো কোম্পানির scheduler পরিবর্তন না করে নতুন database/deployment-এর নিজস্ব worker চালাতে হবে।
- [ ] নিচের feature flags নতুন environment-এ উদ্দেশ্য অনুযায়ী পুনঃস্থাপন করতে হবে। Production-এ missing flag-এর কারণে feature বন্ধ থাকতে পারে; তাই শুধু code copy করে parity নিশ্চিত নয়।

```text
BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED
BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED
BOOKING_RECONCILIATION_ACTIONS_ENABLED
BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED
BOOKING_NOTIFICATION_OUTBOX_ENABLED
BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED
BOOKING_PNR_DEADLINE_REFRESH_ENABLED
TICKET_MANAGEMENT_ENABLED
```

Source: `lib/booking-lifecycle/rollout.ts`, `lib/ticket-management/rollout.ts`। Local env-কে production settings-এর পূর্ণ তালিকা ধরা যাবে না।

## ৯. Branding: কোথায় কী বদলাতে হবে

`app`, `lib`, `components`-এর `.ts/.tsx` ফাইলে `shapon|shopon` অনুসন্ধানে **৪৯টি ফাইল** মেলেছে। এর মধ্যে user-visible text ছাড়াও comments ও internal identifiers আছে; সবগুলোতে blind replacement করা ঠিক হবে না।

| অংশ | প্রধান ফাইল/স্থান | পরিবর্তন |
|---|---|---|
| যোগাযোগ | `lib/site.ts` | Phone, tel link, WhatsApp, email, Facebook, address |
| Header/footer/sidebar | `components/layout/Header.tsx`, `Footer.tsx`, `SiteLogoMark.tsx`; `components/dashboard/DashboardSidebar.tsx` | Company name, logo alt text, accessibility labels, copyright |
| Authentication | `app/(auth)/layout.tsx`, `components/auth/AuthPromoPanel.tsx`, `lib/clerk-appearance.ts` | Auth page branding ও appearance |
| SEO/page title | `app/layout.tsx`, `app/(dashboard)/layout.tsx`, dashboard page metadata, `app/(marketing)/[slug]/page.tsx` | Title, description, Open Graph/Twitter text |
| Marketing/legal/support content | `lib/footer-pages.ts` | About, career, contact, FAQ, privacy ও terms-এ কোম্পানির পরিচয়/নীতি অনুযায়ী লেখা |
| Booking/ticket identity | `lib/db/flight-bookings.ts`, `lib/email/booking-template.ts`, SQL `0073` | Name, actual company license, address, contact এবং B2B fallback |
| Booking/share UI | `components/flights/BookingCheckout.tsx`, `FlightResults.tsx`, `PostTicketActionsPreview.tsx` | Company text, booking updates, service fee labels |
| Ticket management | `components/dashboard/ticket-management/TicketManagementWorkspace.tsx` | Service fee label |
| Wallet UI/API | `components/dashboard/wallet/`, `app/api/wallet/deposits/route.ts` | Company account/branch labels, placeholders ও validation messages |
| Reports | `app/api/reports/issued-tickets/route.ts` | PDF heading ও Excel creator metadata |
| Other direct text | `components/dashboard/FlightSearchTrustStrip.tsx`, `lib/upgrade.ts`, announcement detail page | Support copy, placeholders ও সরাসরি লেখা contact |
| Colours | `lib/colors.ts`, `app/globals.css`, `tailwind.config.ts`, `lib/clerk-appearance.ts`, `app/layout.tsx`, email inline styles | নতুন palette সব surface-এ মিলিয়ে দেওয়া |
| Project identity | `package.json`, `package-lock.json`, project documentation | বর্তমানে package name `nextjs`; নতুন নাম/description ও setup docs |

লোগো ও কিছু marketing asset dashboard থেকে পরিচালিত হয়। কিন্তু company name/contact/license-এর সম্পূর্ণ একক settings system নেই। Implementation-এর সময় এসব তথ্য কেন্দ্রীয় company configuration-এ নেওয়া উপযোগী; database-generated snapshot ও SMS recipient-এর জন্য database-side configuration-ও প্রয়োজন হবে।

### ঐচ্ছিক: reference prefixes ও internal names

- Booking public reference `STR...` এবং agency code `ST-B2B...` source/database-এ আছে (`0017_booking_lifecycle.sql`, `0002_agencies_and_sub_users.sql`, `lib/db/agencies.ts`)। Prefix রাখা হলেও core feature চলতে পারে; নতুন branded prefix চাইলে generator, SQL constraints, validation, parsing ও tests একসঙ্গে বদলাতে হবে।
- Supplier-issued reference prefix নিজের company prefix ধরে বদলানো যাবে না; supplier import rules আলাদা।
- Browser storage keys `shopon-booking-*`, `shopon-flight-booking-snapshot:*` এবং backup/remediation format identifiers আছে। এগুলো user-visible branding নয়; rename করলে সংশ্লিষ্ট readers/writers/tests একসঙ্গে মিলাতে হবে।
- পুরোনো backup format বদলালে পুরোনো tooling compatibility প্রভাবিত হতে পারে। এই audit-এ কিছু rename করা হয়নি।

## ১০. Vercel, Git ও local environment

- [ ] নতুন নামে GitHub repository তৈরি করে এই local project connect করতে হবে। পুরোনো `babuas25/shopontravels` repository অপরিবর্তিত রাখতে হবে।
- [ ] নতুন Vercel project-কে নতুন repository-র সঙ্গে যুক্ত করতে হবে; নতুন domain ও preview/production environment পৃথকভাবে সেট করতে হবে।
- [ ] `APP_URL` নতুন canonical origin দিতে হবে। Code fallback: `NEXT_PUBLIC_APP_URL`, তারপর `VERCEL_PROJECT_PRODUCTION_URL`; invitation ও বাইরে পাঠানো links এতে নির্ভর করে।
- [ ] `.github/workflows/ci.yml`-এর build-এ নতুন repository secret `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` লাগবে। Workflow file নিজে পুরোনো remote Git connection নয়।
- [ ] `.env.local` ও `.env.development.local`-এর পুরোনো service values নতুন target অনুযায়ী বদলাতে হবে। `VERCEL_OIDC_TOKEN` নতুন project-এর reusable credential হিসেবে copy করা উচিত নয়।
- [ ] নতুন build-এর আগে প্রয়োজনমতো `.next` cache পরিষ্কার করতে হবে, যাতে পুরোনো build output ব্যবহার না হয়। এখন মুছে দেওয়া হয়নি।
- [ ] `.gitignore`-এ environment/local link/cache exclusions বজায় রাখতে হবে।

যাচাইয়ের সময় `.git`, `.vercel`, `vercel.json`, `.openai/hosting.json` পাওয়া যায়নি। `.clerk/` ও `supabase/.temp/` আছে। Local `.vercel` না থাকা দিয়ে remote Vercel project নেই বা disconnect হয়েছে—এটি প্রমাণ হয় না।

## ১১. বর্তমান documentation-এর ঘাটতি

- `.env.example` শুধু supplier, Redis ও SMS-এর কিছু key রাখে; Clerk, Supabase, SMTP, Cloudinary, canonical URL, cron এবং rollout flags-এর পূর্ণ template নেই। নতুন setup-এর সময় secret ছাড়া পূর্ণ example লাগবে।
- `docs/15-DEPLOYMENT.md`-এ পুরোনো Supabase project/domain আছে। সেখানে Cloudinary-এর `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` উল্লেখ আছে, কিন্তু বর্তমান runtime code পড়ে `CLOUDINARY_CLOUD_NAME`।
- একই deployment doc-এ `vercel.json` উল্লেখ আছে, অথচ local file নেই। Documentation-এর তুলনায় বর্তমান source ও প্রকৃত service dashboard যাচাই করে setup করতে হবে।
- পুরোনো brand ধরে লেখা assertions আছে, যেমন `scripts/verify-booking-notification-hidden-bcc.mjs`, `scripts/verify-booking-email-template.mjs`, `scripts/verify-ticket-management-ui.mjs`। Branding বদলানোর সময় expected values বদলাতে হবে, আচরণ যাচাইয়ের assertions বাদ দেওয়া যাবে না।

## ১২. পরবর্তী implementation-এর প্রস্তাবিত ক্রম

1. নতুন company identity সংগ্রহ: নাম, slug, domain, logo/palette, ঠিকানা, support/booking email ও phone, WhatsApp/Facebook, প্রকৃত license, archive email ও admin SMS recipients।
2. নতুন database, Clerk application, Cloudinary environment, Redis, SMTP/SMS ও supplier account প্রস্তুত করা।
3. Clean database bootstrap-এর বাধা সমাধান করে সম্পূর্ণ schema/RPC/RLS/trigger install rehearsal করা; পুরোনো data repair আলাদা করা।
4. কেন্দ্রীয় brand/contact configuration, SQL company defaults, asset folders, templates ও রিপোর্টের identity পরিবর্তন করা।
5. নতুন credentials, URL, Clerk webhook, cron/Vault, admin account, supplier controls, wallet payment accounts, markup ও feature flags সেট করা।
6. নতুন environment-এ feature verification শেষ করা; এরপর নতুন repository/Vercel deployment launch করা।

### Launch-এর আগে acceptance checklist

- [ ] নতুন database-এর clean install সম্পূর্ণ হয়; সব প্রয়োজনীয় RPC/view/trigger ও permissions থাকে।
- [ ] Signup/signin, email verification, invitation ও প্রতিটি role-এর access কাজ করে।
- [ ] Search/reprice/booking/issue/cancel, resume এবং expiry/reconciliation intended configuration-এ কাজ করে।
- [ ] Wallet deposit/approval/ledger/refund, bank/MFS display এবং reports ঠিক থাকে।
- [ ] Ticket management ও IMP/EXP paths নতুন environment-এ যাচাই হয়।
- [ ] Email/SMS কেবল নতুন কোম্পানির intended recipient-এ যায়; BCC/admin recipients ও supplier contact নতুন তথ্য ব্যবহার করে।
- [ ] Logo/favicon, upload/private document access, marketing content, PDF/Excel, booking share ও SEO-তে নতুন branding দেখা যায়।
- [ ] সব cron endpoints নতুন deployment/database-এ কাজ করে; প্রয়োজনীয় feature flags সক্রিয় থাকে।
- [ ] নতুন app পুরোনো database, Redis, Clerk, Cloudinary assets বা supplier credentials ব্যবহার করছে না।
- [ ] পুরোনো GitHub repository ও পুরোনো কোম্পানির deployment অপরিবর্তিত থাকে।

## ১৩. এই audit-এ যাচাইয়ের ফল ও সীমাবদ্ধতা

- Source inspection-এ উপরোক্ত bindings, hardcoded values ও clean-install বাধা পাওয়া গেছে।
- `node scripts/verify-migration-order.mjs` চালানো হয়েছে: **passed**। Scriptটি filename uniqueness এবং নির্দিষ্ট migration chain-এর source/order checks করে; SQL execution বা খালি database-এ successful install প্রমাণ করে না।
- Build/dev server চালানো হয়নি: বর্তমান credentials দিয়ে data fetch বা অন্য runtime interaction এড়াতে এই audit source inspection-এ সীমাবদ্ধ রাখা হয়েছে।
- Live database, Clerk/Vercel/Cloudinary dashboards, SMTP/SMS delivery ও supplier account status যাচাই করা হয়নি। বর্তমান production enabled settings ও নতুন credentials-এর কার্যকারিতা পরবর্তী setup-এ যাচাই করতে হবে।
- এই নোট ছাড়া কোনো project file পরিবর্তন করার নির্দেশ নেই; implementation-এর সব checkbox ভবিষ্যতের কাজ।
