# אתר מעיין בשן

## פיתוח מקומי

```bash
npm install
npm run dev
```

האתר יעלה בכתובת http://localhost:4321

## פריסה (Netlify) - שלבים חד-פעמיים

1. העלו את הריפו הזה ל-GitHub (או GitLab/Bitbucket).
2. ב-Netlify: "Add new site" → "Import an existing project" → חברו את הריפו.
   - Build command: `npm run build`
   - Publish directory: `dist`
3. **הפעלת Netlify Identity** (נדרש כדי שמעיין תוכל להתחבר לפאנל הניהול):
   - Site settings → Identity → Enable Identity
   - Identity → Registration → הגבילו ל-"Invite only"
   - Identity → Services → Git Gateway → Enable Git Gateway
4. הזמינו את מעיין כמשתמשת: Identity → Invite users → הזינו את המייל שלה. היא תקבל מייל הזמנה, תגדיר סיסמה, ומאותו רגע תוכל להתחבר בכתובת `https://<הדומיין>/admin`.
5. **חיבור הדומיין הקיים:**
   - Domain settings → Add a domain → הזינו את הדומיין הקיים.
   - Netlify יציג רשומות DNS (CNAME/A) - עדכנו אותן אצל ספק הדומיין.
   - המתינו להטמעת תעודת ה-SSL האוטומטית (בדרך כלל עד שעה).
6. אחרי שהדומיין הסופי מחובר, עדכנו את `site` ב-`astro.config.mjs` לדומיין האמיתי ועשו commit. שימו לב גם ל-`public/admin/config.yml`: הערך `backend.branch: main` מניח שברירת המחדל של הריפו ב-GitHub היא `main` - אם ענף ברירת המחדל שונה, עדכנו את הערך בהתאם.

## עריכת תוכן

מעיין נכנסת ל-`/admin`, מתחברת, ועורכת: הגדרות כלליות, אודות, תקשורת, הרצאות וקורסים, ארגונים, המלצות, ולוגואים. כל שמירה יוצרת commit ומפעילה דיפלוי אוטומטי (כדקה עד שהשינוי עולה לאוויר).

## תעודות סיום

מערכת הפקת תעודות הסיום לבוגרי הקורס (יולי 2026) נמצאת בכתובת `/certificate`.
תיעוד מלא: [CERTIFICATES.md](./CERTIFICATES.md)

האימות מתבצע לפי **שם + מספר טלפון** מול רשימת המשתתפים ששילמו בקורס יולי 2026.
מספר הטלפון משמש לאימות בלבד ואינו מופיע על התעודה. מספר תעודת הזהות שהוזן
מודפס על התעודה, ואם השדה ריק ב-Airtable הוא גם נשמר שם — כך שהמאגר מתמלא
מעצמו. מרגע שנשמרה ת"ז, כל בקשה נוספת חייבת להתאים לה.

הסבר מלא על שיקולי האבטחה נמצא ב-[CERTIFICATES.md](./CERTIFICATES.md).

**הערה על מחיקת תוכן:** אם פריט שנמחק דרך פאנל הניהול ממשיך להופיע באתר אחרי הדיפלוי, יש להריץ דיפלוי עם ניקוי cache ב-Netlify (Deploys → Trigger deploy → "Clear cache and deploy site"). זה קורה כי Astro שומר מטמון תוכן ב-`node_modules/.astro` ש-Netlify עשוי לשמר בין דיפלויים.
