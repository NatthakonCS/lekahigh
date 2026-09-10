require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const line = require('@line/bot-sdk');
const cors = require('cors');

// ตั้งค่า Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ตั้งค่า LINE
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
});

const app = express();
app.use(cors());
app.use(express.static('public'));

// ==========================================
// 1. API สำหรับหน้าเว็บ (Dashboard & LIFF)
// ==========================================
const apiRouter = express.Router();
apiRouter.use(express.json()); // ให้ API ฝั่งเว็บอ่าน JSON ได้

// 1.1 ดึงประวัติทั้งหมดไปแสดงหน้าเว็บ
apiRouter.get('/data', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'ไม่พบรหัสผู้ใช้งาน' });
  const { data, error } = await supabase.from('transactions').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 1.2 ดึงหมวดหมู่ไปแสดงหน้าเว็บ
apiRouter.get('/categories', async (req, res) => {
  const userId = req.query.userId;
  const { data } = await supabase.from('user_categories').select('*').eq('user_id', userId);
  res.json(data || []);
});

// 1.3 สร้างหมวดหมู่ใหม่จากหน้าเว็บ
apiRouter.post('/categories', async (req, res) => {
  const { userId, wallet_type, category_name, monthly_limit } = req.body;
  const { error } = await supabase.from('user_categories').insert([{ user_id: userId, wallet_type, category_name, monthly_limit }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// 1.4 ลบหมวดหมู่จากหน้าเว็บ
apiRouter.delete('/categories', async (req, res) => {
  const { userId, wallet_type, category_name } = req.body;
  const { error } = await supabase.from('user_categories').delete().match({ user_id: userId, wallet_type, category_name });
  res.json({ success: !error });
});

// 1.5 ลบประวัติรายการ (จากปุ่มถังขยะในหน้าเว็บ)
apiRouter.delete('/transactions', async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ error: 'ไม่พบ ID รายการ' });
  const { error } = await supabase.from('transactions').delete().eq('id', transactionId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.use('/api', apiRouter);

// ==========================================
// 2. ระบบแชทบอต (LINE Webhook)
// ==========================================
// ⚠️ ต้องใช้ line.middleware ดักก่อนเสมอ ห้ามใช้ express.json แทรก
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  const userId = event.source.userId;

  // 🟢 2.1 กรณีผู้ใช้ "พิมพ์ข้อความ"
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // -- ฟีเจอร์ดูสรุป --
    if (text === 'สรุป' || text === 'สรุปยอด') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data } = await supabase.from('transactions').select('*').eq('user_id', userId).gte('created_at', startOfMonth);
      
      let incP = 0, expP = 0, incB = 0, expB = 0;
      if (data) {
        data.forEach(item => {
          if (item.wallet_type === 'personal') { item.category === 'รายรับ' ? incP += item.amount : expP += item.amount; }
          else { item.category === 'รายรับ' ? incB += item.amount : expB += item.amount; }
        });
      }
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ 
          type: 'text', 
          text: `📊 สรุปยอดเดือนนี้\n\n🏠 ส่วนตัว\nรับ: ฿${incP.toLocaleString()} | จ่าย: ฿${expP.toLocaleString()}\nสุทธิ: ฿${(incP - expP).toLocaleString()}\n\n🏢 ร้านค้า\nรับ: ฿${incB.toLocaleString()} | จ่าย: ฿${expB.toLocaleString()}\nสุทธิ: ฿${(incB - expB).toLocaleString()}` 
        }]
      });
    }

    // -- ฟีเจอร์บันทึกยอด (ค้นหาตัวเลขในประโยค) --
    const match = text.match(/([+-]?\d+(?:\.\d+)?)/);
    if (match) {
      let rawAmount = match[1];
      let note = text.replace(rawAmount, '').trim().substring(0, 40); // ดึงข้อความที่เหลือเป็นโน้ต
      let isIncome = rawAmount.startsWith('+');
      let amount = Math.abs(parseFloat(rawAmount));

      if (amount > 0) {
        const typeText = isIncome ? 'รายรับ' : 'รายจ่าย';
        const walletButtons = [
          {
            type: 'action',
            action: {
              type: 'postback',
              label: '🏠 ส่วนตัว',
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

        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `ยอด${typeText} ฿${amount.toLocaleString()}\n📝 โน้ต: ${note || '-'}\n\n👇 เลือกว่าจะบันทึกเข้ากระเป๋าไหนครับ`,
            quickReply: { items: walletButtons }
          }]
        });
      }
    } 
    // -- ถ้าพิมพ์มาไม่มีตัวเลข (แก้ข้อความตามที่พี่สั่ง) --
    else if (text !== 'วิธีใช้') {
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ 
          type: 'text', 
          text: '💡 กรุณาพิมพ์ตัวเลขเพื่อบันทึกยอดครับ (เช่น "100 เสื้อ" หรือ "+500") หรือพิมพ์ "สรุป" เพื่อดูยอดเดือนนี้นะครับ' 
        }]
      });
    }
  }

  // 🟢 2.2 กรณีผู้ใช้ "กดปุ่ม (Quick Reply / Flex)"
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('a');
    const amount = parseFloat(params.get('m'));
    const wallet = params.get('w');
    const note = params.get('n');

    // 2.2.1 ถามหมวดหมู่
    if (action === 'ask_cat') {
      const { data: cats } = await supabase.from('user_categories').select('category_name').eq('user_id', userId).eq('wallet_type', wallet);
      
      let catNames = [];
      if (cats && cats.length > 0) {
        catNames = cats.map(c => c.category_name).filter(c => c !== 'รายรับ').slice(0, 13);
      } 
      if (catNames.length === 0) catNames = ['อาหาร', 'เดินทาง', 'ช้อปปิ้ง', 'ทั่วไป'];

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
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `${walletIcon} เลือกหมวดหมู่สำหรับยอด ฿${amount.toLocaleString()} ครับ`,
          quickReply: { items: catButtons }
        }]
      });
    }

    // 2.2.2 บันทึกลง Database
    else // สเต็ปบันทึกและเช็กลิมิต
    if (action === 'save' || action === 'save_tx') {
      // 1. บันทึกลง Database (พร้อม Note)
      await supabase.from('transactions').insert([{ 
        amount: amount, 
        wallet_type: wallet, 
        category: category, 
        user_id: userId, 
        note: note || '' 
      }]);
      
      // เตรียมข้อมูลตัวแปรสำหรับแสดงผลข้อความ
      const isIncome = category === 'รายรับ';
      const typeName = isIncome ? 'รายรับ' : 'รายจ่าย';
      const emoji = isIncome ? '🟢' : '🔴';
      const walletIcon = wallet === 'personal' ? '🏠 ส่วนตัว' : '🏢 ร้านค้า';

      // ข้อความโชว์ตามที่พี่ต้องการเป๊ะๆ
      let replyMsg = `✅ บันทึก${typeName}สำเร็จ!\n${emoji} จำนวน: ฿${amount.toLocaleString()}\n💼 กระเป๋า: ${walletIcon}\n📂 หมวด: ${category}\n📝 โน้ต: ${note || '-'}`;

      // 2. ระบบแจ้งเตือนลิมิตโควตา (เตือนเฉพาะตอนใช้เกิน)
      if (category !== 'รายรับ') {
        const { data: limitData } = await supabase.from('user_categories')
          .select('monthly_limit')
          .eq('user_id', userId)
          .eq('wallet_type', wallet)
          .eq('category_name', category)
          .single();
        
        if (limitData && limitData.monthly_limit > 0) {
          const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
          const { data: txData } = await supabase.from('transactions')
            .select('amount')
            .eq('user_id', userId)
            .eq('wallet_type', wallet)
            .eq('category', category)
            .gte('created_at', startOfMonth);
          
          const currentTotal = txData.reduce((sum, item) => sum + item.amount, 0);
          
          // 🔥 แทรกคำเตือนใน LINE เฉพาะตอนใช้เงินเกินลิมิตเท่านั้น
          if (currentTotal > limitData.monthly_limit) {
            replyMsg += `\n\n🚨 แจ้งเตือน!: หมวด "${category}" ทะลุโควตา ${limitData.monthly_limit.toLocaleString()} บาทแล้ว! (ยอดปัจจุบัน: ${currentTotal.toLocaleString()} บาท)`;
          }
        }
      }
      return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyMsg }] });
    }
  }

  return Promise.resolve(null);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});