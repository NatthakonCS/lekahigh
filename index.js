// ==========================================
// 6. ระบบแชทบอต (LINE Webhook) - อัปเกรดมีปุ่ม Quick Reply
// ==========================================
app.post('/webhook', express.json(), async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) return res.status(200).send('OK');

    for (const event of events) {
        const userId = event.source.userId;
        const LINE_TOKEN = process.env.LINE_ACCESS_TOKEN; 

        // ฟังก์ชันช่วยส่งข้อความกลับไปหา LINE
        const replyMessage = async (replyToken, payload) => {
            try {
                await fetch('https://api.line.me/v2/bot/message/reply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
                    body: JSON.stringify({ replyToken: replyToken, messages: [payload] })
                });
            } catch (err) { console.error("LINE Reply Error:", err); }
        };

        // 🟢 1. กรณีผู้ใช้ "กดปุ่ม" จาก Quick Reply (Postback Event)
        if (event.type === 'postback') {
            const data = new URLSearchParams(event.postback.data);
            
            if (data.get('action') === 'save_expense') {
                const amount = parseFloat(data.get('amt'));
                const category = data.get('cat');
                const note = data.get('note');

                // บันทึกลงฐานข้อมูล Supabase
                const { error } = await supabase.from('transactions').insert([{
                    userId: userId,
                    amount: amount,
                    category: category, 
                    wallet_type: 'personal',
                    note: note // บันทึกข้อความเตือนความจำ
                }]);

                if (!error) {
                    await replyMessage(event.replyToken, { 
                        type: 'text', 
                        text: `✅ บันทึกรายจ่ายเรียบร้อย!\n🔴 จำนวน: ฿${amount.toLocaleString()}\n📂 หมวดหมู่: ${category}\n📝 โน้ต: ${note || '-'}` 
                    });
                }
            }
        }

        // 🟢 2. กรณีผู้ใช้ "พิมพ์ข้อความ" เข้ามา
        else if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text.trim();

            if (text === 'สรุป') {
                // (Logic สรุปยอดสามารถดึงโค้ดเก่ามาใส่ตรงนี้ได้เลยครับ)
                await replyMessage(event.replyToken, { type: 'text', text: 'กำลังคำนวณสรุปยอดให้ครับ...' });
            } 
            else {
                // แยกตัวเลข กับ ข้อความ (เช่น "500 กินข้าวกับเพื่อน")
                const parts = text.split(' ');
                let rawAmount = parts[0];
                let note = parts.slice(1).join(' '); // ข้อความที่เหลือทั้งหมด

                // ถ้ารายรับ (ใส่ + นำหน้า) ให้บันทึกเลยเพื่อความไว
                if (rawAmount.startsWith('+')) {
                    const amount = parseFloat(rawAmount.substring(1));
                    if (!isNaN(amount) && amount > 0) {
                        await supabase.from('transactions').insert([{ userId, amount, category: 'รายรับ', wallet_type: 'personal', note }]);
                        await replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึกรายรับ!\n🟢 จำนวน: ฿${amount.toLocaleString()}\n📝 โน้ต: ${note || '-'}` });
                    }
                } 
                // ถ้ารายจ่าย (พิมพ์แค่ตัวเลข) ให้เด้งปุ่มเลือกหมวดหมู่!
                else {
                    const amount = parseFloat(rawAmount);
                    if (!isNaN(amount) && amount > 0) {
                        const safeNote = note.substring(0, 50); // กันไม่ให้ตัวอักษรเกินข้อจำกัดของ LINE
                        
                        // สร้างปุ่มตัวเลือก (ดัดแปลงชื่อหมวดได้ตามใจชอบครับ)
                        const categories = ['อาหาร', 'เดินทาง', 'ช้อปปิ้ง', 'ทั่วไป']; 
                        
                        const quickReplyButtons = categories.map(cat => ({
                            type: 'action',
                            action: {
                                type: 'postback',
                                label: `📂 ${cat}`, // ข้อความบนปุ่ม
                                data: `action=save_expense&amt=${amount}&cat=${cat}&note=${safeNote}`, // ซ่อนข้อมูลส่งให้ระบบ
                                displayText: `บันทึกหมวด: ${cat}` // สิ่งที่จะเด้งพิมพ์ในแชทตอนผู้ใช้กด
                            }
                        }));

                        await replyMessage(event.replyToken, {
                            type: 'text',
                            text: `💸 ยอด: ${amount.toLocaleString()} บาท\n📝 โน้ต: ${note || 'ไม่ได้ระบุ'}\n\n👇 กดเลือกหมวดหมู่เพื่อบันทึกได้เลยครับ`,
                            quickReply: { items: quickReplyButtons }
                        });
                    }
                }
            }
        }
    }
    res.status(200).send('OK');
});