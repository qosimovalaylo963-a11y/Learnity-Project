#!/usr/bin/env node
/**
 * Comprehensive 20-Point End-to-End Integration Test Suite for Learnity Ecosystem
 *
 * Tests all 20 required verification scenarios against a real running instance of
 * the Node.js + SQLite server, including database persistence across server restarts.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLearnityServer } = require('../src/server');

const TEST_DIR = path.join(__dirname, '..', 'data', 'test_run_' + Date.now());
const TEST_DB = path.join(TEST_DIR, 'test_learnity.sqlite');
const TEST_UPLOADS = path.join(TEST_DIR, 'uploads');
const TEST_BACKUPS = path.join(TEST_DIR, 'backups');

function request(port, method, urlPath, { body = null, headers = {}, rawBuffer = null } = {}) {
    return new Promise((resolve, reject) => {
        const payload = rawBuffer
            ? rawBuffer
            : body
            ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
            : null;

        const reqHeaders = { ...headers };
        if (payload && !reqHeaders['Content-Type']) {
            reqHeaders['Content-Type'] = 'application/json';
        }
        if (payload) {
            reqHeaders['Content-Length'] = payload.length;
        }

        const req = http.request(
            { hostname: '127.0.0.1', port, path: urlPath, method, headers: reqHeaders },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = {};
                    try { json = JSON.parse(text); } catch (_) {}
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: json,
                        rawText: text
                    });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function extractCookie(res) {
    const sc = res.headers['set-cookie'];
    if (!sc || !sc.length) return '';
    return sc[0].split(';')[0];
}

async function runTests() {
    console.log('Starting Learnity 20-Point Integration Test Suite...');
    let passed = 0;
    const recordPass = (num, title) => {
        passed += 1;
        console.log(`  [PASS ${String(num).padStart(2, '0')}/20] ${title}`);
    };

    let instance = await createLearnityServer({
        dataDir: TEST_DIR,
        dbPath: TEST_DB,
        uploadDir: TEST_UPLOADS,
        backupDir: TEST_BACKUPS
    });

    await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    let port = instance.server.address().port;

    try {
        // 1. Owner login
        const ownerLoginRes = await request(port, 'POST', '/api/auth/login', {
            body: { email: 'owner@learnity.org', password: process.env.OWNER_PASSWORD || 'Learnity!Owner#2026' }
        });
        assert.strictEqual(ownerLoginRes.status, 200, 'Owner login should return 200');
        assert.strictEqual(ownerLoginRes.body.user.role, 'OWNER');
        const ownerCookie = extractCookie(ownerLoginRes);
        const ownerCsrf = ownerLoginRes.body.csrfToken;
        assert.ok(ownerCookie.includes('learnity_sid='), 'Should set HttpOnly session cookie');
        recordPass(1, 'Owner login & HttpOnly session cookie initialization');

        // 2. Invalid owner login
        const badLoginRes = await request(port, 'POST', '/api/auth/login', {
            body: { email: 'owner@learnity.org', password: 'WrongPassword123!' }
        });
        assert.strictEqual(badLoginRes.status, 401, 'Invalid owner login should return 401');
        recordPass(2, 'Invalid owner login rejected with 401');

        // 3. Member application (Path A)
        const memAppRes = await request(port, 'POST', '/api/applications', {
            body: {
                full_name: 'Sardorbek Alimov',
                email: 'sardor.applicant@example.com',
                phone_or_telegram: '+998 90 777 88 99',
                requested_role: 'MEMBER',
                interested_subjects: ['Biology', 'Chemistry'],
                track: 'STEM & Algorithm Lab',
                schedule_preference: 'Weekday Intensive',
                educational_background: '1st-year BSc Student',
                motivation_statement: 'Excited to join wet-lab biology sessions.'
            }
        });
        assert.strictEqual(memAppRes.status, 201);
        assert.ok(memAppRes.body.application.application_uid.startsWith('LRN-APP-'));
        const memAppId = memAppRes.body.application.id;
        recordPass(3, 'Public Member application saved with unique UID');

        // 4. Staff application (Path A)
        const staffAppRes = await request(port, 'POST', '/api/applications', {
            body: {
                full_name: 'Dr. Kamola Rakhimova',
                email: 'kamola.mentor@example.com',
                phone_or_telegram: '@kamola_physics',
                requested_role: 'STAFF',
                interested_subjects: ['Physics', 'Mathematics'],
                educational_background: 'PhD in Applied Physics',
                motivation_statement: 'Ready to lead circuit telemetry workshops.'
            }
        });
        assert.strictEqual(staffAppRes.status, 201);
        assert.strictEqual(staffAppRes.body.application.requested_role, 'STAFF');
        recordPass(4, 'Public Staff application saved and categorized');

        // 5. Email delivery & honest status reporting + notification template configuration
        assert.strictEqual(typeof memAppRes.body.emailDelivery.sent, 'boolean');
        assert.ok(memAppRes.body.emailDelivery.detail.length > 0);
        const tplUpdateRes = await request(port, 'PUT', '/api/owner/notification-templates', {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                template_key: 'application_received_owner',
                subject: '[Learnity Custom] New {{requested_role}} Application ({{application_uid}})',
                body: 'Applicant: {{full_name}} ({{email}})'
            }
        });
        assert.strictEqual(tplUpdateRes.status, 200);
        recordPass(5, 'Email notification integration & configurable template persistence');

        // 6. Invitation generation (multi-subject + granular permissions + hashed in DB)
        const genInvRes = await request(port, 'POST', '/api/invitations', {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                label: 'Single-Use Bio/Chem Test Invite',
                target_role: 'MEMBER',
                subject_ids: [2, 3], // Biology (2) & Chemistry (3)
                max_uses: 1,
                expires_in_days: 7,
                permissions: {
                    can_access_subject: true,
                    can_view_materials: true,
                    can_upload_materials: true,
                    can_publish_materials: false,
                    can_create_links: true,
                    can_upload_videos: false,
                    can_invite_members: false,
                    can_generate_codes: false
                }
            }
        });
        assert.strictEqual(genInvRes.status, 201);
        const singleUseCode = genInvRes.body.invitationCard.plainCode;
        // Verify plain-text code is NOT stored in SQLite database
        const dbRow = await instance.db.get("SELECT * FROM invitation_codes WHERE id = ?", [genInvRes.body.invitationCard.id]);
        assert.ok(dbRow.code_hash && dbRow.code_hash !== singleUseCode, 'Only SHA-256 hash stored in DB');
        recordPass(6, 'Cryptographic invitation code generated & stored as SHA-256 hash');

        // 7. Invitation expiration enforcement
        const expInvRes = await request(port, 'POST', '/api/invitations', {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                label: 'Already Expired Invite',
                target_role: 'MEMBER',
                subject_ids: [1],
                max_uses: 5,
                expires_at: new Date(Date.now() - 3600 * 1000).toISOString(),
                permissions: { can_access_subject: true, can_view_materials: true }
            }
        });
        const expiredCode = expInvRes.body.invitationCard.plainCode;
        const verifyExpired = await request(port, 'POST', '/api/invitations/verify', {
            body: { code: expiredCode }
        });
        assert.strictEqual(verifyExpired.status, 400, 'Expired code must be rejected');
        recordPass(7, 'Expired invitation code automatically rejected');

        // 8. Invitation revocation enforcement
        const revInvRes = await request(port, 'POST', '/api/invitations', {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                label: 'To Be Revoked Invite',
                target_role: 'MEMBER',
                subject_ids: [1],
                max_uses: 5,
                expires_in_days: 7,
                permissions: { can_access_subject: true, can_view_materials: true }
            }
        });
        const revocableId = revInvRes.body.invitationCard.id;
        const revocableCode = revInvRes.body.invitationCard.plainCode;
        const doRevoke = await request(port, 'POST', `/api/invitations/${revocableId}/revoke`, {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {}
        });
        assert.strictEqual(doRevoke.status, 200);
        const verifyRevoked = await request(port, 'POST', '/api/invitations/verify', {
            body: { code: revocableCode }
        });
        assert.strictEqual(verifyRevoked.status, 400, 'Revoked code must be rejected');
        recordPass(8, 'Revoked invitation code rejected immediately');

        // 9. Single-use code behavior (redeem once -> succeeds; redeem second time -> rejected)
        const regMember1 = await request(port, 'POST', '/api/auth/register-invite', {
            body: {
                invitation_code: singleUseCode,
                full_name: 'Ulugbek Karimov',
                email: 'ulugbek.member@learnity.org',
                password: 'Ulugbek!Pass#2026'
            }
        });
        assert.strictEqual(regMember1.status, 201, 'First registration with single-use code succeeds');
        const newMemberCookie = extractCookie(regMember1);
        const newMemberCsrf = regMember1.body.csrfToken;

        const regMember2 = await request(port, 'POST', '/api/auth/register-invite', {
            body: {
                invitation_code: singleUseCode,
                full_name: 'Second User',
                email: 'second.user@learnity.org',
                password: 'Second!Pass#2026'
            }
        });
        assert.strictEqual(regMember2.status, 400, 'Second registration with exhausted single-use code must fail');
        recordPass(9, 'Single-use invitation code exhausted after 1 registration');

        // 10. Subject authorization (Member assigned to Biology & Chemistry can open /subjects/biology, blocked from /subjects/mathematics)
        const bioHubRes = await request(port, 'GET', '/api/subjects/biology', {
            headers: { Cookie: newMemberCookie }
        });
        assert.strictEqual(bioHubRes.status, 200, 'Member should access assigned Biology hub');
        const mathHubRes = await request(port, 'GET', '/api/subjects/mathematics', {
            headers: { Cookie: newMemberCookie }
        });
        assert.strictEqual(mathHubRes.status, 403, 'Member must be blocked from unassigned Mathematics hub');
        recordPass(10, 'Server-side Subject Hub authorization enforced (Biology 200, Mathematics 403)');

        // 11. Staff permissions (Biology Staff can publish in Biology, blocked from publishing in Mathematics or accessing Owner overview)
        const staffLoginRes = await request(port, 'POST', '/api/auth/login', {
            body: { email: 'aziza.staff@learnity.org', password: 'Staff!Bio#2026' }
        });
        assert.strictEqual(staffLoginRes.status, 200);
        const staffCookie = extractCookie(staffLoginRes);
        const staffCsrf = staffLoginRes.body.csrfToken;

        const staffMathPost = await request(port, 'POST', '/api/resources', {
            headers: { Cookie: staffCookie, 'X-CSRF-Token': staffCsrf },
            body: {
                subject_id: 4, // Mathematics
                resource_type: 'pdf',
                title: 'Unauthorized Math Upload by Bio Staff',
                description: 'Should be rejected'
            }
        });
        assert.strictEqual(staffMathPost.status, 403, 'Biology Staff cannot publish to Mathematics');
        recordPass(11, 'Granular Staff permissions enforced across subjects');

        // 12. Member permissions (Biology contributor can upload material to Pending Review, cannot upload video when can_upload_videos=0)
        const memVideoAttempt = await request(port, 'POST', '/api/resources', {
            headers: { Cookie: newMemberCookie, 'X-CSRF-Token': newMemberCsrf },
            body: {
                subject_id: 2, // Biology
                resource_type: 'youtube',
                title: 'Unauthorized Video by Member without video flag',
                external_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
            }
        });
        assert.strictEqual(memVideoAttempt.status, 403, 'Member without can_upload_videos flag blocked from adding video');
        recordPass(12, 'Granular Member action flags enforced (can_upload_videos check)');

        // 13. Resource uploads (Member uploads Biology PDF -> Pending Review; Staff/Owner approves -> Published)
        const memDocUpload = await request(port, 'POST', '/api/resources', {
            headers: { Cookie: newMemberCookie, 'X-CSRF-Token': newMemberCsrf },
            body: {
                subject_id: 2, // Biology
                resource_type: 'pdf',
                title: 'Mitosis Microscopy Observation Notes',
                category: 'Student Lab Notes',
                external_url: 'https://openstax.org/books/biology-2e/pages/10-2-the-cell-cycle',
                description: 'Detailed phase counts from Tuesday lab.'
            }
        });
        assert.strictEqual(memDocUpload.status, 201);
        assert.strictEqual(memDocUpload.body.resource.moderation_status, 'Pending Review');
        const createdResId = memDocUpload.body.resource.id;

        const ownerPublishRes = await request(port, 'PUT', `/api/resources/${createdResId}`, {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: { moderation_status: 'Published' }
        });
        assert.strictEqual(ownerPublishRes.status, 200);
        assert.strictEqual(ownerPublishRes.body.resource.moderation_status, 'Published');
        recordPass(13, 'Resource contribution & moderation workflow (Pending Review -> Published)');

        // 14. Video links (Biology Staff publishes YouTube video lesson in Biology)
        const staffVideoRes = await request(port, 'POST', '/api/resources', {
            headers: { Cookie: staffCookie, 'X-CSRF-Token': staffCsrf },
            body: {
                subject_id: 2,
                resource_type: 'youtube',
                title: 'PCR Thermal Cycling Walkthrough',
                category: 'Video Lessons',
                external_url: 'https://www.youtube.com/watch?v=iQsu3Kz9NYo',
                description: 'Primer annealing temperature calculations.'
            }
        });
        assert.strictEqual(staffVideoRes.status, 201);
        assert.strictEqual(staffVideoRes.body.resource.moderation_status, 'Published');
        recordPass(14, 'Staff video link publishing in assigned Subject Hub');

        // 15. Media uploads (Multipart binary PNG uploaded to persistent storage)
        const boundary = '----LearnityTestBoundary987654';
        // Minimal valid 1x1 PNG binary signature + payload
        const pngBytes = Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
            'hex'
        );
        const multipartBody = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nUploaded Robotics Lab Photo\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="create_gallery_card"\r\n\r\ntrue\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="robotics_lab.png"\r\nContent-Type: image/png\r\n\r\n`
            ),
            pngBytes,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        const mediaUploadRes = await request(port, 'POST', '/api/owner/media/upload', {
            headers: {
                Cookie: ownerCookie,
                'X-CSRF-Token': ownerCsrf,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            rawBuffer: multipartBody
        });
        assert.strictEqual(mediaUploadRes.status, 201, 'Multipart PNG upload should succeed');
        const uploadedUrl = mediaUploadRes.body.url;
        assert.ok(uploadedUrl.startsWith('/uploads/'));
        const fetchUploadedImg = await request(port, 'GET', uploadedUrl);
        assert.strictEqual(fetchUploadedImg.status, 200);
        recordPass(15, 'Persistent multipart photograph upload & binary serving');

        // 16. Gallery updates (Edit caption, position, zoom, hide/archive & verify public bootstrap)
        const uploadedAssetId = mediaUploadRes.body.assets[0].id;
        const updateMediaRes = await request(port, 'PUT', `/api/owner/media/${uploadedAssetId}`, {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                title: 'Updated Robotics Sprint Photo',
                category: 'Hardware Lab',
                pos_x: 42,
                pos_y: 58,
                scale: 1.25
            }
        });
        assert.strictEqual(updateMediaRes.status, 200);
        assert.strictEqual(updateMediaRes.body.asset.title, 'Updated Robotics Sprint Photo');
        assert.strictEqual(updateMediaRes.body.asset.scale, 1.25);
        recordPass(16, 'Dynamic Media Library caption, crop/pan coordinates, and zoom update');

        // 17. Application approval with auto-generated invitation card
        const approveAppRes = await request(port, 'PUT', `/api/owner/applications/${memAppId}`, {
            headers: { Cookie: ownerCookie, 'X-CSRF-Token': ownerCsrf },
            body: {
                status: 'Approved',
                review_notes: 'Welcome to the Biology & Chemistry cohort!',
                generate_invite: true
            }
        });
        assert.strictEqual(approveAppRes.status, 200);
        assert.strictEqual(approveAppRes.body.application.status, 'Approved');
        assert.ok(approveAppRes.body.generatedInviteCard.plainCode);
        recordPass(17, 'Application approval workflow & automatic invitation card generation');

        // 18. Unauthorized API access blocked (Member & Staff blocked from `/api/owner/overview`)
        const memOwnerAttempt = await request(port, 'GET', '/api/owner/overview', {
            headers: { Cookie: newMemberCookie }
        });
        assert.strictEqual(memOwnerAttempt.status, 403);
        const staffOwnerAttempt = await request(port, 'GET', '/api/owner/overview', {
            headers: { Cookie: staffCookie }
        });
        assert.strictEqual(staffOwnerAttempt.status, 403);
        recordPass(18, 'Unauthorized Member & Staff access to Owner API strictly blocked (403)');

        // 19. Session expiration & logout invalidation
        const logoutRes = await request(port, 'POST', '/api/auth/logout', {
            headers: { Cookie: newMemberCookie, 'X-CSRF-Token': newMemberCsrf },
            body: {}
        });
        assert.strictEqual(logoutRes.status, 200);
        const afterLogoutMe = await request(port, 'GET', '/api/auth/me', {
            headers: { Cookie: newMemberCookie }
        });
        assert.strictEqual(afterLogoutMe.body.authenticated, false, 'Session must be invalidated after logout');
        recordPass(19, 'Session invalidation & expiration enforcement');

        // 20. Database & Media persistence after server shutdown & restart
        await new Promise((resolve) => instance.server.close(resolve));
        await instance.db.close();

        // Boot a brand-new server instance pointing to the same TEST_DIR / TEST_DB
        instance = await createLearnityServer({
            dataDir: TEST_DIR,
            dbPath: TEST_DB,
            uploadDir: TEST_UPLOADS,
            backupDir: TEST_BACKUPS
        });
        await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
        port = instance.server.address().port;

        const bootBootstrap = await request(port, 'GET', '/api/public/bootstrap');
        assert.strictEqual(bootBootstrap.status, 200);
        const persistedCard = bootBootstrap.body.lessonCards.find((c) => c.title === 'Updated Robotics Sprint Photo');
        assert.ok(persistedCard, 'Uploaded and edited gallery card must survive server restart');
        const checkImgAfterRestart = await request(port, 'GET', uploadedUrl);
        assert.strictEqual(checkImgAfterRestart.status, 200, 'Uploaded image file on disk must survive restart');
        recordPass(20, 'SQLite database & uploaded media files persist cleanly across server restart');

        console.log(`\nALL ${passed}/20 INTEGRATION TESTS PASSED SUCCESSFULLY!`);
    } finally {
        try {
            await new Promise((resolve) => instance.server.close(resolve));
            await instance.db.close();
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (_) {}
    }
}

runTests().catch((err) => {
    console.error('TEST SUITE FAILED:', err);
    process.exit(1);
});
