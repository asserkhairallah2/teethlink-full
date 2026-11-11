import { pool } from '../src/db/pool.js';

async function main() {
  await pool.query(`
    INSERT INTO notifications (user_id, type, title, body, data, case_id, is_read, created_at)
    VALUES
      (
        7, 'BED_OCCUPIED',
        'تم إشغال الكرسي وبدء جلستك العلاجية',
        'قام د. عمر خالد ببدء الجلسة على الكرسي C2-B01 بعيادة 2. يرجى التوجه لغرفة الكشف.',
        '{"bedLabel":"C2-B01","clinicNumber":"C2"}'::jsonb, 5, FALSE, now() - INTERVAL '40 minutes'
      ),
      (
        7, 'EXAM_BOOKED',
        'تأكيد حجز الكشف المبدئي',
        'تم تأكيد حجز الكشف المبدئي الخاص بك بمستشفى جامعة 6 أكتوبر بنجاح.',
        '{}'::jsonb, NULL, TRUE, now() - INTERVAL '3 hours'
      ),
      (
        4, 'CASE_CLAIMED',
        'تم سحب الحالة بنجاح',
        'لقد قمت بسحب حالة المريضة سارة أحمد حسن (#TL-0001004) وتفعيل المحادثة الطبية.',
        '{"caseId":5}'::jsonb, 5, TRUE, now() - INTERVAL '50 minutes'
      ),
      (
        2, 'PATIENT_CHECKED_IN',
        'حضور مريض لعيادة الكشف المبدئي',
        'المريضة فاطمة علي إبراهيم متواجدة الآن بقاعة الانتظار وجاهزة للفرز الإكلينيكي.',
        '{"bookingId":1}'::jsonb, NULL, FALSE, now() - INTERVAL '15 minutes'
      ),
      (
        1, 'ACCOUNT_PENDING_APPROVAL',
        'طلب تسجيل طبيب جديد بانتظار الاعتماد',
        'قام د. كريم مصطفى (سنة رابعة) بتقديم طلب انضمام لقسم العلاج التحفظي وبانتظار موافقتك.',
        '{"candidateId":6}'::jsonb, NULL, FALSE, now() - INTERVAL '2 hours'
      )
  `);
  console.log('Sample notifications inserted successfully!');
  await pool.end();
}

main().catch(console.error);
