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
// ฟังก์ชันแยกประเภท Event ที่ LINE ส่งมา
async function handleEvent(event) {
  

  // 1. ดักจับข้อความที่พิมพ์มา (ตรวจสอบให้เป็นตัวเลขเท่านั้น)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim(); // รับข้อความและตัดช่องว่างหัวท้ายทิ้ง

    // 💡 [เช็กตัวเลข] ถ้าไม่ใช่ตัวเลข (isNaN) หรือพิมพ์มาแต่ช่องว่างเปล่าๆ
    if (isNaN(text) || text === "") {
      // ให้บอตตอบกลับไปเตือน แล้วจบการทำงานทันที (return)
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ 
          type: 'text', 
          text: '❌ กรุณาพิมพ์เฉพาะ "ตัวเลข" ยอดเงินที่ต้องการบันทึกนะครับ 😅' 
        }],
      });
    }

    // ถ้าผ่านด่านข้างบนมาได้ แปลว่าเป็นตัวเลขชัวร์ๆ ค่อยให้แสดงปุ่ม Flex Message
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
      if (action === 'category') {
        const categoryFlex = {
          type: 'flex',
          altText: 'เลือกหมวดหมู่',
          contents: {
            type: 'bubble',
            body: {
              type: 'box', layout: 'vertical',
              contents: [
                { type: 'text', text: `ยอด ${amount} บาท`, weight: 'bold', size: 'xl' },
                { type: 'text', text: 'เป็นค่าอะไรเอ่ย?', margin: 'md' }
              ]
            },
            footer: {
              type: 'box', layout: 'vertical', spacing: 'sm',
              contents: [
                { // ปุ่มรายรับ
                  type: 'button', style: 'primary', color: '#4CAF50',
                  action: {
                    type: 'postback', label: '💰 รายรับ',
                    // ส่งข้อมูลทั้งหมดไปเซฟ!
                    data: `action=save&wallet=${wallet}&amount=${amount}&category=รายรับ`, 
                    displayText: 'รายรับ'
                  }
                },
                { // ปุ่มค่าอาหาร
                  type: 'button', style: 'secondary',
                  action: {
                    type: 'postback', label: '🍜 ค่าอาหาร',
                    data: `action=save&wallet=${wallet}&amount=${amount}&category=ค่าอาหาร`,
                    displayText: 'ค่าอาหาร'
                  }
                },
                { // ปุ่มค่าเดินทาง
                  type: 'button', style: 'secondary',
                  action: {
                    type: 'postback', label: '🚗 ค่าเดินทาง',
                    data: `action=save&wallet=${wallet}&amount=${amount}&category=ค่าเดินทาง`,
                    displayText: 'ค่าเดินทาง'
                  }
                }
              ]
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