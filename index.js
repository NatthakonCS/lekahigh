require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const express = require('express');
const line = require('@line/bot-sdk');

// ตั้งค่า Configuration
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// สร้าง Client สำหรับยิง API กลับไปหา LINE
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
});

const app = express();
app.use(express.static('public')); // 💡 เพิ่มบรรทัดนี้ เพื่อบอกให้ระบบรู้จักโฟลเดอร์ public
const cors = require('cors');
app.use(cors()); // อนุญาตให้ Netlify หรือเว็บอื่นๆ มาดึงข้อมูล API ได้

// สร้าง Endpoint รอรับ Webhook (ใช้ Middleware ของ LINE ช่วยตรวจสอบความปลอดภัย)
// ==========================================
// 6. ระบบแชทบอต (LINE Webhook) - อัปเกรดฉลาด 100%
// ==========================================
app.post('/webhook', express.json(), async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) return res.status(200).send('OK');

    for (const event of events) {
        const userId = event.source.userId;
        const LINE_TOKEN = process.env.LINE_ACCESS_TOKEN; 

        // ฟังก์ชันช่วยส่งข้อความ LINE
        const replyMessage = async (replyToken, payload) => {
            try {
                await fetch('https://api.line.me/v2/bot/message/reply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
                    body: JSON.stringify({ replyToken: replyToken, messages: [payload] })
                });
            } catch (err) { console.error("LINE Reply Error:", err); }
        };

        // 🟢 1. กรณีผู้ใช้ "กดปุ่ม (Quick Reply)"
        if (event.type === 'postback') {
            const params = new URLSearchParams(event.postback.data);
            const action = params.get('a');
            const amount = parseFloat(params.get('m'));
            const wallet = params.get('w');
            const note = params.get('n');

            // 1.1 ถ้ากดเลือกกระเป๋าแล้ว -> เด้งปุ่มถามหมวดหมู่ต่อ (ดึงจากฐานข้อมูลจริง)
            if (action === 'ask_cat') {
                // ดึงหมวดหมู่จาก Supabase ตามกระเป๋าที่เลือก
                const { data: cats } = await supabase.from('categories').select('category_name').eq('userId', userId).eq('wallet_type', wallet);
                
                let catNames = [];
                if (cats && cats.length > 0) {
                    // เอาเฉพาะรายจ่าย และจำกัดแค่ 13 ปุ่ม (ตามข้อจำกัด LINE)
                    catNames = cats.map(c => c.category_name).filter(c => c !== 'รายรับ').slice(0, 13);
                } 
                if (catNames.length === 0) catNames = ['อาหาร', 'เดินทาง', 'ช้อปปิ้ง', 'ทั่วไป']; // ค่าเริ่มต้นถ้ายังไม่ได้ตั้งค่า

                const catButtons = catNames.map(c => ({
                    type: 'action',
                    action: {
                        type: 'postback',
                        label: `📂 ${c.length > 18 ? c.substring(0,18) : c}`, 
                        data: `a=save_tx&m=${amount}&w=${wallet}&c=${c}&n=${note}`,
                        displayText: `เลือกหมวด: ${c}`
                    }
                }));

                const walletIcon = wallet === 'personal' ? '🏠' : '🏢';
                await replyMessage(event.replyToken, {
                    type: 'text',
                    text: `${walletIcon} เลือกหมวดหมู่สำหรับยอด ฿${amount.toLocaleString()} ครับ`,
                    quickReply: { items: catButtons }
                });
            }
            
            // 1.2 ถ้ากดเลือกหมวดหมู่เสร็จแล้ว (หรือเป็นรายรับ) -> บันทึกลงฐานข้อมูลเลย
            else if (action === 'save_tx') {
                const category = params.get('c');
                const { error } = await supabase.from('transactions').insert([{
                    userId: userId,
                    amount: amount,
                    category: category,
                    wallet_type: wallet,
                    note: note
                }]);

                const isIncome = category === 'รายรับ';
                const emoji = isIncome ? '🟢' : '🔴';
                const typeName = isIncome ? 'รายรับ' : 'รายจ่าย';
                const walletIcon = wallet === 'personal' ? '🏠 ส่วนตัว' : '🏢 ร้านค้า';

                await replyMessage(event.replyToken, {
                    type: 'text',
                    text: `✅ บันทึก${typeName}สำเร็จ!\n${emoji} จำนวน: ฿${amount.toLocaleString()}\n💼 กระเป๋า: ${walletIcon}\n📂 หมวดหมู่: ${category}\n📝 โน้ต: ${note || '-'}`
                });
            }
        }

        // 🟢 2. กรณีผู้ใช้ "พิมพ์ข้อความ" (ดักจับตัวเลขและโน้ตแบบฉลาด)
        else if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            if (text === 'สรุป' || text === 'สรุปยอด') {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
                const { data } = await supabase.from('transactions').select('*').eq('userId', userId).gte('created_at', startOfMonth);
                let incP = 0, expP = 0, incB = 0, expB = 0;
                if (data) {
                    data.forEach(item => {
                        if (item.wallet_type === 'personal') { item.category === 'รายรับ' ? incP += item.amount : expP += item.amount; }
                        else { item.category === 'รายรับ' ? incB += item.amount : expB += item.amount; }
                    });
                }
                await replyMessage(event.replyToken, { 
                    type: 'text', 
                    text: `📊 สรุปยอดเดือนนี้\n\n🏠 ส่วนตัว\nรับ: ฿${incP.toLocaleString()} | จ่าย: ฿${expP.toLocaleString()}\nสุทธิ: ฿${(incP - expP).toLocaleString()}\n\n🏢 ร้านค้า\nรับ: ฿${incB.toLocaleString()} | จ่าย: ฿${expB.toLocaleString()}\nสุทธิ: ฿${(incB - expB).toLocaleString()}`
                });
            } 
            else {
                // อัปเกรด Regex: ค้นหาตัวเลขในประโยค แม้จะพิมพ์ติดกันเช่น "ค่าเสื้อ100" หรือ "+1000ขายของ"
                const match = text.match(/([+-]?\d+(?:\.\d+)?)/);
                
                if (match) {
                    let rawAmount = match[1];
                    let note = text.replace(rawAmount, '').trim().substring(0, 40); // ดึงข้อความที่เหลือมาเป็นโน้ต (ลิมิต 40 ตัวอักษร)
                    
                    let isIncome = rawAmount.startsWith('+');
                    let amount = Math.abs(parseFloat(rawAmount)); // ป้องกันค่าติดลบ

                    if (amount > 0) {
                        // สเต็ปแรก: เด้งปุ่มถามกระเป๋าก่อนเสมอ!
                        const typeText = isIncome ? 'รับ' : 'จ่าย';
                        const walletButtons = [
                            {
                                type: 'action',
                                action: {
                                    type: 'postback',
                                    label: '🏠 ส่วนตัว',
                                    // ถ้ารายรับ ข้ามไปบันทึกเลย (save_tx) ถ้ารายจ่าย ให้ไปถามหมวดหมู่ (ask_cat)
                                    data: `a=${isIncome ? 'save_tx' : 'ask_cat'}&m=${amount}&w=personal&c=${isIncome ? 'รายรับ' : ''}&n=${note}`,
                                    displayText: `กระเป๋าส่วนตัว`
                                }
                            },
                            {
                                type: 'action',
                                action: {
                                    type: 'postback',
                                    label: '🏢 ร้านค้า',
                                    data: `a=${isIncome ? 'save_tx' : 'ask_cat'}&m=${amount}&w=business&c=${isIncome ? 'รายรับ' : ''}&n=${note}`,
                                    displayText: `กระเป๋าร้านค้า`
                                }
                            }
                        ];

                        await replyMessage(event.replyToken, {
                            type: 'text',
                            text: `ยอด${typeText} ฿${amount.toLocaleString()}\n📝 โน้ต: ${note || '-'}\n\n👇 เลือกกระเป๋าที่ต้องการบันทึกครับ`,
                            quickReply: { items: walletButtons }
                        });
                    }
                } 
                else {
                    // ถ้าในประโยคไม่มีตัวเลขเลย
                    if (text !== 'วิธีใช้') {
                        await replyMessage(event.replyToken, { type: 'text', text: 'กรุณาพิมพ์ตัวเลขเพื่อบันทึกยอดครับ (เช่น 100 เสื้อ หรือ +500)' });
                    }
                }
            }
        }
    }
    res.status(200).send('OK');
});

// ฟังก์ชันแยกประเภท Event ที่ LINE ส่งมา
async function handleEvent(event) {
  

  // ==========================================
  // 1. ดักจับข้อความที่พิมพ์มา (ตัวเลข หรือ คำสั่ง)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim(); 
    const userId = event.source.userId; // ดึงรหัสคนใช้งาน

    // 💡 ฟีเจอร์ใหม่: ถ้าพิมพ์คำว่า "สรุป"
    if (text === 'สรุป') {
      // หาวันที่ของวันนี้ เพื่อเอาไปฟิลเตอร์ข้อมูล
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startOfDay = today.toISOString();
      today.setHours(23, 59, 59, 999);
      const endOfDay = today.toISOString();

      // ดึงข้อมูลจาก Supabase (เฉพาะของ user คนนี้ และเฉพาะวันนี้)
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', startOfDay)
        .lte('created_at', endOfDay);

      if (error) {
        console.error(error);
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '❌ ดึงข้อมูลสรุปไม่ได้ครับ ลองใหม่อีกครั้งนะ' }]
        });
      }

      // นำข้อมูลมาบวกเลขแยกตามกระเป๋า
      let pIncome = 0, pExpense = 0; // ส่วนตัว
      let bIncome = 0, bExpense = 0; // ร้านค้า

      data.forEach(item => {
        if (item.wallet_type === 'personal') {
          if (item.category === 'รายรับ') pIncome += item.amount;
          else pExpense += item.amount; // รวมค่าอาหาร, ค่าเดินทาง
        } else if (item.wallet_type === 'business') {
          if (item.category === 'รายรับ') bIncome += item.amount;
          else bExpense += item.amount; // รวมรายจ่าย, ต้นทุน
        }
      });

      // จัดข้อความเพื่อตอบกลับ
      const summaryText = `📊 สรุปยอดวันนี้\n\n🏠 ส่วนตัว\nรายรับ: ${pIncome} ฿\nรายจ่าย: ${pExpense} ฿\nคงเหลือ: ${pIncome - pExpense} ฿\n\n🏢 ร้านค้า\nรายรับ: ${bIncome} ฿\nรายจ่าย: ${bExpense} ฿\nคงเหลือ: ${bIncome - bExpense} ฿`;

      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: summaryText }]
      });
    }

    // 💡 [เช็กตัวเลข] ถ้าไม่ใช่คำสั่ง "สรุป" และไม่ใช่ตัวเลข ให้เตือน
    if (isNaN(text) || text === "") {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ 
          type: 'text', 
          text: '❌ กรุณาพิมพ์ "ตัวเลข" เพื่อบันทึกยอด หรือพิมพ์ "สรุป" เพื่อดูยอดวันนี้นะครับ' 
        }],
      });
    }

    // ถ้าพิมพ์ตัวเลขมา ให้แสดง Flex Message เลือกกระเป๋าตามปกติ
    const amount = text; 

    const flexMessage = {
      type: 'flex',
      altText: 'เลือกกระเป๋าเพื่อบันทึกยอด',
      // ... (โค้ด Flex Message ตรงนี้เหมือนเดิม ไม่ต้องเปลี่ยนครับ)
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: `ยอด ${amount} บาท`, weight: 'bold', size: 'xl' },
            { type: 'text', text: 'บันทึกเข้ากระเป๋าไหนดีครับ?', margin: 'md' }
          ]
        },
        footer: {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#42a5f5', // โทนสีฟ้า
              action: {
                type: 'postback',
                label: '🏠 ส่วนตัว',
                // ตรงนี้คือการฝังข้อมูลลับไว้หลังปุ่ม!
                data: `action=category&wallet=personal&amount=${amount}`, 
                displayText: 'บันทึกเข้าส่วนตัว' // คำที่จะเด้งขึ้นแชทตอนกดปุ่ม
              }
            },
            {
              type: 'button',
              style: 'primary',
              color: '#ff9800', // โทนสีส้ม
              action: {
                type: 'postback',
                label: '🏢 ร้านค้า',
                // ฝังข้อมูลของร้านค้า
                data: `action=category&wallet=business&amount=${amount}`,
                displayText: 'บันทึกเข้าร้านค้า'
              }
            }
          ]
        }
      }
    };

    // ส่ง Flex Message กลับไปหาผู้ใช้
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [flexMessage],
    });
  }

  // ==========================================
    // 2. ดักจับการกดปุ่ม (Event ประเภท Postback)
    // ==========================================
    if (event.type === 'postback') {
      const userId = event.source.userId; // ดึงรหัสคนใช้งาน
      const postbackData = event.postback.data; 
      
      const params = new URLSearchParams(postbackData);
      const action = params.get('action');
      const wallet = params.get('wallet');
      const amount = params.get('amount');
      const category = params.get('category'); // รับค่าหมวดหมู่เพิ่มมา

      // สเต็ป 2.1: ถ้าเพิ่งกดเลือกกระเป๋ามา ให้เด้งถามหมวดหมู่ต่อ
      // สเต็ป 2.1: ถ้าเพิ่งกดเลือกกระเป๋ามา ให้เด้งถามหมวดหมู่ต่อ
      if (action === 'category') {
        // ดึงหมวดหมู่ของคนๆ นี้จาก Database
        let { data: cats } = await supabase.from('user_categories')
          .select('*').eq('user_id', userId).eq('wallet_type', wallet);

        // ระบบ Auto-Seed: ถ้าเพิ่งใช้ครั้งแรก (ยังไม่มีหมวดหมู่) ให้สร้างค่าเริ่มต้นให้เลย
        if (!cats || cats.length === 0) {
          const defaultCats = wallet === 'business' 
            ? [{user_id: userId, wallet_type: wallet, category_name: 'รายรับ', monthly_limit: 0}, {user_id: userId, wallet_type: wallet, category_name: 'รายจ่าย', monthly_limit: 0}]
            : [{user_id: userId, wallet_type: wallet, category_name: 'รายรับ', monthly_limit: 0}, {user_id: userId, wallet_type: wallet, category_name: 'ค่าอาหาร', monthly_limit: 5000}];
          
          await supabase.from('user_categories').insert(defaultCats);
          cats = defaultCats;
        }

        // เอาข้อมูลมาสร้างปุ่ม (LINE จำกัดสูงสุด 5-6 ปุ่มกำลังสวย)
        const categoryButtons = cats.slice(0, 5).map(c => ({
          type: 'button', 
          style: c.category_name === 'รายรับ' ? 'primary' : 'secondary', 
          color: c.category_name === 'รายรับ' ? '#4CAF50' : undefined,
          action: { 
            type: 'postback', label: c.category_name, 
            data: `action=save&wallet=${wallet}&amount=${amount}&category=${c.category_name}`, 
            displayText: c.category_name 
          }
        }));

        const categoryFlex = {
          type: 'flex', altText: 'เลือกหมวดหมู่',
          contents: {
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical',
              contents: [
                { type: 'text', text: `ยอด ${amount} บาท`, weight: 'bold', size: 'xl' },
                { type: 'text', text: 'หมวดหมู่ไหนดีครับ?', margin: 'md', color: '#666666' }
              ]
            },
            footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: categoryButtons }
          }
        };
        return client.replyMessage({ replyToken: event.replyToken, messages: [categoryFlex] });
      }

      // สเต็ป 2.2: พอกดเลือกหมวดหมู่เสร็จ ค่อยเอาลง Database
      if (action === 'save') {
        await supabase.from('transactions').insert([{ amount: parseInt(amount), wallet_type: wallet, category: category, user_id: userId }]);
        let replyMsg = `✅ บันทึก ${category} ยอด ${amount} บาท เรียบร้อย!`;

        // ระบบแจ้งเตือนลิมิต (ข้ามการเช็กถ้าเป็นรายรับ)
        if (category !== 'รายรับ') {
          const { data: limitData } = await supabase.from('user_categories')
            .select('monthly_limit').eq('user_id', userId).eq('wallet_type', wallet).eq('category_name', category).single();
          
          if (limitData && limitData.monthly_limit > 0) {
            const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
            const { data: txData } = await supabase.from('transactions').select('amount')
              .eq('user_id', userId).eq('wallet_type', wallet).eq('category', category).gte('created_at', startOfMonth);
            
            const currentTotal = txData.reduce((sum, item) => sum + item.amount, 0);
            
            if (currentTotal > limitData.monthly_limit) {
              replyMsg += `\n\n🚨 เตือนภัย!: คุณใช้หมวด "${category}" ทะลุโควตา ${limitData.monthly_limit.toLocaleString()} บาทแล้ว (ยอดปัจจุบัน: ${currentTotal.toLocaleString()} บาท)`;
            } else {
              replyMsg += `\n(โควตาหมวดนี้เหลือ ${(limitData.monthly_limit - currentTotal).toLocaleString()} บาท)`;
            }
          }
        }
        return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyMsg }] });
      }
    }

  // ถ้าเป็น Event อื่นๆ ที่ไม่ได้เขียนดักไว้ ก็ให้ปล่อยผ่าน
  return Promise.resolve(null);
  
}
// ==========================================
// 3. API สำหรับส่งข้อมูลให้หน้าเว็บ Dashboard
// ==========================================
app.get('/api/data', async (req, res) => {
  const userId = req.query.userId; // รับรหัสคนเปิดเว็บ
  
  if (!userId) {
    return res.status(400).json({ error: 'ไม่พบรหัสผู้ใช้งาน' });
  }

  // ดึงข้อมูลทั้งหมดของคนๆ นี้จาก Supabase
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false }); // เรียงจากใหม่ไปเก่า

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // ส่งข้อมูลกลับไปให้หน้าเว็บ
  res.json(data);
});
  // ==========================================
// 4. API สำหรับจัดการหมวดหมู่ผ่านหน้าเว็บ
// ==========================================

// 4.1 ขอดูหมวดหมู่ทั้งหมดของตัวเอง
app.get('/api/categories', async (req, res) => {
  const userId = req.query.userId;
  const { data, error } = await supabase.from('user_categories').select('*').eq('user_id', userId);
  res.json(data || []);
});

// 4.2 สร้างหมวดหมู่ใหม่ + ตั้งลิมิต
app.post('/api/categories', express.json(), async (req, res) => {
  const { userId, wallet_type, category_name, monthly_limit } = req.body;
  const { error } = await supabase.from('user_categories').insert([
    { user_id: userId, wallet_type: wallet_type, category_name: category_name, monthly_limit: monthly_limit }
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// 4.3 ลบหมวดหมู่ทิ้ง
app.delete('/api/categories', express.json(), async (req, res) => {
  const { userId, wallet_type, category_name } = req.body;
  const { error } = await supabase.from('user_categories')
    .delete().match({ user_id: userId, wallet_type: wallet_type, category_name: category_name });
  res.json({ success: !error });
});
// ==========================================
// 6. ระบบแชทบอต (LINE Webhook) - อัปเกรดฉลาด 100%
// ==========================================


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});