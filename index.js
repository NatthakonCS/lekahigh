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
  
  // ==========================================
  // 1. ดักจับข้อความที่พิมพ์มา (สมมติว่าพิมพ์ยอดเงิน)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const amount = event.message.text; // รับข้อความ (เราจะสมมติว่าคุณฟิวพิมพ์ตัวเลขเข้ามา)

    // สร้าง Flex Message ให้เลือกกระเป๋า
    const flexMessage = {
      type: 'flex',
      altText: 'เลือกกระเป๋าเพื่อบันทึกยอด',
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
                data: `action=save&wallet=personal&amount=${amount}`, 
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
                data: `action=save&wallet=business&amount=${amount}`,
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
    // ดึงก้อนข้อมูลลับที่เราฝังไว้ในปุ่มออกมา
    const postbackData = event.postback.data; 
    
    // แปลงก้อนข้อมูลให้อ่านง่ายขึ้น (เช่น action=save&wallet=personal&amount=500)
    const params = new URLSearchParams(postbackData);
    const action = params.get('action');
    const wallet = params.get('wallet');
    const amount = params.get('amount');

    if (action === 'save') {
      const walletName = wallet === 'personal' ? '🏠 ส่วนตัว' : '🏢 ร้านค้า';
      
      // โยนข้อมูลลง Database
      const { data, error } = await supabase
        .from('transactions')
        .insert([
          { amount: parseInt(amount), wallet_type: wallet }
        ]);

      if (error) {
        console.error('เกิดข้อผิดพลาด:', error);
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '❌ ระบบมีปัญหา บันทึกข้อมูลไม่ได้ครับ' }]
        });
      }

      // ถ้าบันทึกสำเร็จ ให้ตอบกลับ
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `✅ บันทึกยอด ${amount} บาท เข้ากระเป๋า ${walletName} ลงระบบเรียบร้อยแล้วครับ!`
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