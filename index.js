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

// สร้าง Endpoint รอรับ Webhook (ใช้ Middleware ของ LINE ช่วยตรวจสอบความปลอดภัย)
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
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
        
        // สร้างตัวแปรเก็บปุ่มหมวดหมู่
        let categoryButtons = [];

        // เช็กว่าเลือกกระเป๋าไหนมา
        if (wallet === 'business') {
          // 📦 ปุ่มสำหรับ "กระเป๋าร้านค้า"
          categoryButtons = [
            {
              type: 'button', style: 'primary', color: '#4CAF50',
              action: { type: 'postback', label: '💰 รายรับ', data: `action=save&wallet=${wallet}&amount=${amount}&category=รายรับ`, displayText: 'รายรับร้านค้า' }
            },
            {
              type: 'button', style: 'secondary',
              action: { type: 'postback', label: '💸 รายจ่าย', data: `action=save&wallet=${wallet}&amount=${amount}&category=รายจ่าย`, displayText: 'รายจ่ายร้านค้า' }
            },
            {
              type: 'button', style: 'secondary',
              action: { type: 'postback', label: '📦 ต้นทุน', data: `action=save&wallet=${wallet}&amount=${amount}&category=ต้นทุน`, displayText: 'ต้นทุนร้านค้า' }
            }
          ];
        } else {
          // 🏠 ปุ่มสำหรับ "กระเป๋าส่วนตัว"
          categoryButtons = [
            {
              type: 'button', style: 'primary', color: '#4CAF50',
              action: { type: 'postback', label: '💰 รายรับ', data: `action=save&wallet=${wallet}&amount=${amount}&category=รายรับ`, displayText: 'รายรับส่วนตัว' }
            },
            {
              type: 'button', style: 'secondary',
              action: { type: 'postback', label: '🍜 ค่าอาหาร', data: `action=save&wallet=${wallet}&amount=${amount}&category=ค่าอาหาร`, displayText: 'ค่าอาหาร' }
            },
            {
              type: 'button', style: 'secondary',
              action: { type: 'postback', label: '🚗 ค่าเดินทาง', data: `action=save&wallet=${wallet}&amount=${amount}&category=ค่าเดินทาง`, displayText: 'ค่าเดินทาง' }
            }
          ];
        }

        // นำปุ่มมาประกอบร่างเป็น Flex Message
        const categoryFlex = {
          type: 'flex',
          altText: 'เลือกหมวดหมู่',
          contents: {
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical',
              contents: [
                { type: 'text', text: `ยอด ${amount} บาท`, weight: 'bold', size: 'xl' },
                { 
                  type: 'text', 
                  text: wallet === 'business' ? '🏢 หมวดหมู่ของร้านค้า' : '🏠 หมวดหมู่ส่วนตัว', 
                  margin: 'md', color: '#666666' 
                }
              ]
            },
            footer: {
              type: 'box', layout: 'vertical', spacing: 'sm',
              contents: categoryButtons // ดึงปุ่มที่แยกไว้มาใส่ตรงนี้
            }
          }
        };

        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [categoryFlex],
        });
      }

      // สเต็ป 2.2: พอกดเลือกหมวดหมู่เสร็จ ค่อยเอาลง Database
      if (action === 'save') {
        const walletName = wallet === 'personal' ? '🏠 ส่วนตัว' : '🏢 ร้านค้า';
        
        // บันทึกลง Supabase (เพิ่ม user_id และ category เข้าไปแล้ว)
        const { error } = await supabase
          .from('transactions')
          .insert([
            { 
              amount: parseInt(amount), 
              wallet_type: wallet,
              category: category,
              user_id: userId
            }
          ]);

        if (error) {
          console.error(error);
          return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ระบบมีปัญหา บันทึกข้อมูลไม่ได้ครับ' }]
          });
        }

        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `✅ บันทึก ${category} ยอด ${amount} บาท เข้ากระเป๋า ${walletName} เรียบร้อย!`
          }],
        });
      }
    }

  // ถ้าเป็น Event อื่นๆ ที่ไม่ได้เขียนดักไว้ ก็ให้ปล่อยผ่าน
  return Promise.resolve(null);
  
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});