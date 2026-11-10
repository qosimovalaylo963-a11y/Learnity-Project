/**
 * Learnity Database Seed & Initial Setup
 *
 * Preserves:
 * 1. All 6 original Learnity classroom photographs & Hero workshop photograph.
 * 2. Exact 8 requested core subjects: Computer Science, Biology, Chemistry,
 *    Mathematics, Economics, Business, Global Politics, Physics.
 * 3. Initial Staff Directory profiles, sample subject resources, announcements,
 *    and notification templates.
 * 4. Owner account provisioned from environment variables (`OWNER_EMAIL`,
 *    `OWNER_PASSWORD`, `OWNER_NAME`).
 */
const { hashPassword, hashInviteCode, generateApplicationUid } = (() => { try { return require('../utils/crypto'); } catch(_) { return require('./crypto'); } })();
const { DEFAULT_TEMPLATES } = (() => { try { return require('../utils/mailer'); } catch(_) { return require('./mailer'); } })();

const ORIGINAL_HERO_PHOTO = {
    card_key: 'hero-main',
    title: 'Learnity Collaborative Workshop',
    caption_date: 'Featured Workshop Snapshot',
    description: 'Tashkent Campus & Hybrid · 5.0 / 5.0 Student Feedback',
    category: 'Featured Hero',
    image_url: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1200&q=85',
    pos_x: 50,
    pos_y: 40,
    scale: 1.02,
    crop_aspect: '16:9',
    display_order: 0,
    is_hero: 1,
    is_visible: 1,
    is_archived: 0
};

const ORIGINAL_LESSON_CARDS = [
    {
        card_key: 'lesson-1',
        category: 'STEM & Robotics Lab',
        caption_date: 'Week 04 · Hardware Sprint',
        title: 'Autonomous Sensor & Circuit Prototyping',
        description: 'Students testing microcontroller logic and sensor calibration in small collaborative pairs.',
        image_url: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 50,
        scale: 1,
        display_order: 1
    },
    {
        card_key: 'lesson-2',
        category: 'Design & Architecture',
        caption_date: 'Week 02 · Studio Critique',
        title: 'Interactive UI Systems & Product Framing',
        description: 'Live whiteboard critique where teams break down real-world interface workflows and typography.',
        image_url: 'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 45,
        scale: 1,
        display_order: 2
    },
    {
        card_key: 'lesson-3',
        category: 'Peer Mentorship',
        caption_date: 'Week 05 · Code Review',
        title: '1-on-1 Algorithm & Debugging Clinics',
        description: 'Senior mentors sitting side-by-side with students to refactor code and explain data structures.',
        image_url: 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 50,
        scale: 1,
        display_order: 3
    },
    {
        card_key: 'lesson-4',
        category: 'Academic Seminar',
        caption_date: 'Week 06 · Group Debate',
        title: 'Structured Research & Analytical Debate',
        description: 'Roundtable discussion developing critical argumentation, public speaking, and synthesis skills.',
        image_url: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 40,
        scale: 1,
        display_order: 4
    },
    {
        card_key: 'lesson-5',
        category: 'Team Hackathon',
        caption_date: 'Week 07 · Build Night',
        title: 'Cross-Disciplinary Capstone Sprint',
        description: 'Developers, designers, and researchers combining forces to ship a working prototype in 48 hours.',
        image_url: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 50,
        scale: 1,
        display_order: 5
    },
    {
        card_key: 'lesson-6',
        category: 'Demo Day',
        caption_date: 'Week 08 · Final Showcase',
        title: 'Cohort Capstone Presentations & Feedback',
        description: 'Graduating teams presenting their completed teaching modules and technical builds to guest reviewers.',
        image_url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=900&q=80',
        pos_x: 50,
        pos_y: 50,
        scale: 1,
        display_order: 6
    }
];

const INITIAL_SUBJECTS = [
    {
        slug: 'computer-science',
        name: 'Computer Science',
        category: 'Computing & Algorithms',
        short_description: 'Algorithms, data structures, software engineering, and hands-on system architecture.',
        intro_html: 'Build production software systems, master algorithmic problem-solving, debug live codebases in 1-on-1 clinics, and ship collaborative team projects.',
        icon_name: 'terminal',
        accent_color: '#f97316',
        lead_instructor: 'Javohirbek Mirzayev',
        schedule_label: 'Tue, Thu & Sat · 19:00 UZT',
        display_order: 1
    },
    {
        slug: 'biology',
        name: 'Biology',
        category: 'Life & Molecular Sciences',
        short_description: 'Cellular systems, genetics, wet-lab microscopy protocols, and physiological modeling.',
        intro_html: 'Explore molecular biology, genetics, cellular respiration, and ecological systems through interactive laboratory protocols, microscopy walks, and peer case studies.',
        icon_name: 'dna',
        accent_color: '#10b981',
        lead_instructor: 'Dr. Aziza Karimova',
        schedule_label: 'Tue & Thu · 17:30 UZT',
        display_order: 2
    },
    {
        slug: 'chemistry',
        name: 'Chemistry',
        category: 'Physical & Organic Sciences',
        short_description: 'Stoichiometry, organic synthesis mechanisms, titration labs, and thermochemistry.',
        intro_html: 'Master reaction kinetics, molecular orbital theory, analytical titration techniques, and organic synthesis mechanisms with guided workshop problem sets.',
        icon_name: 'flask-conical',
        accent_color: '#f59e0b',
        lead_instructor: 'Sardor Rakhimov',
        schedule_label: 'Mon & Wed · 18:00 UZT',
        display_order: 3
    },
    {
        slug: 'mathematics',
        name: 'Mathematics',
        category: 'Pure & Applied Analysis',
        short_description: 'Multivariable calculus, linear algebra, combinatorics, and proof construction.',
        intro_html: 'Develop rigorous proof writing, linear algebra intuition, differential equations modeling, and competitive problem-solving strategies.',
        icon_name: 'sigma',
        accent_color: '#ec4899',
        lead_instructor: 'Prof. Rustam Yuldashev',
        schedule_label: 'Tue & Sat · 16:00 UZT',
        display_order: 4
    },
    {
        slug: 'economics',
        name: 'Economics',
        category: 'Markets & Policy Analysis',
        short_description: 'Microeconomic theory, macroeconomic modeling, game theory, and econometrics.',
        intro_html: 'Analyze market equilibria, monetary and fiscal policy, behavioral incentives, and empirical datasets through real-world economic case studies.',
        icon_name: 'trending-up',
        accent_color: '#38bdf8',
        lead_instructor: 'Madina Saidova',
        schedule_label: 'Mon & Thu · 16:30 UZT',
        display_order: 5
    },
    {
        slug: 'business',
        name: 'Business',
        category: 'Strategy & Entrepreneurship',
        short_description: 'Corporate strategy, financial modeling, product operations, and venture building.',
        intro_html: 'Evaluate unit economics, competitive strategy, organizational design, and go-to-market execution in interactive Harvard-style case workshops.',
        icon_name: 'briefcase',
        accent_color: '#a855f7',
        lead_instructor: 'Madina Saidova',
        schedule_label: 'Fridays · 18:00 UZT',
        display_order: 6
    },
    {
        slug: 'global-politics',
        name: 'Global Politics',
        category: 'International Relations & Governance',
        short_description: 'Geopolitics, comparative governance, diplomacy simulations, and policy debate.',
        intro_html: 'Examine international institutions, sovereignty, human rights frameworks, and conflict resolution through structured diplomatic simulations and debates.',
        icon_name: 'globe',
        accent_color: '#14b8a6',
        lead_instructor: 'Dr. Aziza Karimova',
        schedule_label: 'Saturdays · 14:00 UZT',
        display_order: 7
    },
    {
        slug: 'physics',
        name: 'Physics',
        category: 'Mechanics & Electromagnetism',
        short_description: 'Classical mechanics, circuit analysis, wave optics, and experimental telemetry.',
        intro_html: 'Bridge mathematical derivation with physical intuition through sensor experiments, circuit prototyping, and olympiad-grade mechanics clinics.',
        icon_name: 'atom',
        accent_color: '#6366f1',
        lead_instructor: 'Timur Alimov',
        schedule_label: 'Wed & Fri · 17:00 UZT',
        display_order: 8
    }
];

async function seedDatabase(db) {
    // 1. Seed Roles
    const roles = [
        ['OWNER', 'Highest-level platform owner with full administrative authority'],
        ['STAFF', 'Instructional staff and mentors with subject-specific workspace permissions'],
        ['MEMBER', 'Enrolled cohort member with access to assigned subject hubs'],
        ['VISITOR', 'Public website visitor and prospective applicant']
    ];
    for (const [name, desc] of roles) {
        await db.run("INSERT OR IGNORE INTO roles (name, description) VALUES (?, ?)", [name, desc]);
    }

    // 2. Seed Owner Account
    const ownerEmail = (process.env.OWNER_EMAIL || 'owner@learnity.org').trim().toLowerCase();
    const ownerPassword = process.env.OWNER_PASSWORD || 'Learnity!Owner#2026';
    const ownerName = process.env.OWNER_NAME || 'Learnity Platform Owner';

    let owner = await db.get("SELECT * FROM users WHERE role = 'OWNER' LIMIT 1");
    if (!owner) {
        const res = await db.run(
            `INSERT INTO users (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json)
             VALUES (?, ?, ?, 'OWNER', 'active', '+998 90 000 00 01', 'Founder & Principal Architect of Learnity.', 1, 1, 1, ?)`,
            [
                ownerName,
                ownerEmail,
                hashPassword(ownerPassword),
                JSON.stringify({
                    can_access_subject: true,
                    can_view_materials: true,
                    can_upload_materials: true,
                    can_publish_materials: true,
                    can_create_links: true,
                    can_upload_videos: true,
                    can_invite_members: true,
                    can_generate_codes: true
                })
            ]
        );
        owner = await db.get("SELECT * FROM users WHERE id = ?", [res.lastInsertRowid]);
    }

    // 3. Seed Initial 8 Subjects
    for (const subj of INITIAL_SUBJECTS) {
        await db.run(
            `INSERT OR IGNORE INTO subjects (slug, name, category, short_description, intro_html, icon_name, accent_color, lead_instructor, schedule_label, display_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                subj.slug,
                subj.name,
                subj.category,
                subj.short_description,
                subj.intro_html,
                subj.icon_name,
                subj.accent_color,
                subj.lead_instructor,
                subj.schedule_label,
                subj.display_order
            ]
        );
    }

    const allSubjects = await db.all("SELECT * FROM subjects ORDER BY display_order ASC");
    const subjBySlug = Object.fromEntries(allSubjects.map((s) => [s.slug, s]));

    // 4. Seed Staff & Member Accounts if not present
    const staffCount = await db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'STAFF'");
    if (!staffCount || staffCount.cnt === 0) {
        const bioStaffRes = await db.run(
            `INSERT INTO users (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json)
             VALUES (?, ?, ?, 'STAFF', 'active', '+998 90 111 22 33', 'Senior Molecular Biology & Global Politics Mentor.', 1, 1, 1, ?)`,
            [
                'Dr. Aziza Karimova',
                'aziza.staff@learnity.org',
                hashPassword('Staff!Bio#2026'),
                JSON.stringify({
                    can_access_subject: true,
                    can_view_materials: true,
                    can_upload_materials: true,
                    can_create_links: true
                })
            ]
        );
        const csStaffRes = await db.run(
            `INSERT INTO users (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json)
             VALUES (?, ?, ?, 'STAFF', 'active', '+998 90 222 33 44', 'Lead Computer Science & Mathematics Instructor.', 0, 0, 1, '{}')`,
            [
                'Javohirbek Mirzayev',
                'javohir.staff@learnity.org',
                hashPassword('Staff!Code#2026')
            ]
        );

        // Assign granular subject permissions to Dr. Aziza (Biology & Global Politics only — NOT Mathematics)
        for (const slug of ['biology', 'global-politics']) {
            if (subjBySlug[slug]) {
                await db.run(
                    `INSERT OR IGNORE INTO user_subjects
                     (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate, assigned_by)
                     VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, ?)`,
                    [bioStaffRes.lastInsertRowid, subjBySlug[slug].id, owner.id]
                );
            }
        }
        // Assign Computer Science, Mathematics & Physics to Javohirbek
        for (const slug of ['computer-science', 'mathematics', 'physics']) {
            if (subjBySlug[slug]) {
                await db.run(
                    `INSERT OR IGNORE INTO user_subjects
                     (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate, assigned_by)
                     VALUES (?, ?, 1, 1, 1, 1, 1, 1, 0, ?)`,
                    [csStaffRes.lastInsertRowid, subjBySlug[slug].id, owner.id]
                );
            }
        }

        // Seed Staff Directory Profiles
        const staffProfiles = [
            {
                user_id: bioStaffRes.lastInsertRowid,
                full_name: 'Dr. Aziza Karimova',
                position: 'Lead Biology & Global Politics Mentor',
                department: 'Life Sciences & Policy',
                photo_url: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=600&q=80',
                bio: 'PhD in Molecular Genetics. Leads wet-lab microscopy workshops and international policy research seminars.',
                responsibilities: 'Biology curriculum design, microscopy workshops, Capstone research supervision',
                assigned_subjects_label: 'Biology, Global Politics',
                display_order: 1
            },
            {
                user_id: csStaffRes.lastInsertRowid,
                full_name: 'Javohirbek Mirzayev',
                position: 'Principal Computer Science & Math Instructor',
                department: 'STEM & Algorithm Lab',
                photo_url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80',
                bio: 'Senior Systems Engineer & competitive programming coach specializing in data structures and interactive web architectures.',
                responsibilities: '1-on-1 debugging clinics, hackathon sprint mentorship, Computer Science & Mathematics labs',
                assigned_subjects_label: 'Computer Science, Mathematics, Physics',
                display_order: 2
            },
            {
                user_id: null,
                full_name: 'Madina Saidova',
                position: 'Economics & Business Case Coordinator',
                department: 'Economics & Strategy',
                photo_url: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=600&q=80',
                bio: 'Fulbright scholar guiding students in macroeconomic analysis, market strategy, and Harvard-style business case competitions.',
                responsibilities: 'Economic policy modeling, business case studios, venture workshops',
                assigned_subjects_label: 'Economics, Business',
                display_order: 3
            },
            {
                user_id: null,
                full_name: 'Sardor Rakhimov',
                position: 'Chemistry & Experimental Lab Specialist',
                department: 'Physical Sciences',
                photo_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=600&q=80',
                bio: 'Analytical chemist passionate about transforming textbook stoichiometry into vivid, hands-on reaction laboratories.',
                responsibilities: 'Lab safety & titration protocols, organic synthesis workshops',
                assigned_subjects_label: 'Chemistry, Physics',
                display_order: 4
            }
        ];

        for (const sp of staffProfiles) {
            await db.run(
                `INSERT INTO staff_profiles (user_id, full_name, position, department, photo_url, bio, responsibilities, assigned_subjects_label, display_order, is_visible)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                [sp.user_id, sp.full_name, sp.position, sp.department, sp.photo_url, sp.bio, sp.responsibilities, sp.assigned_subjects_label, sp.display_order]
            );
        }
    }

    // Seed Member Account
    const memberCount = await db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'MEMBER'");
    if (!memberCount || memberCount.cnt === 0) {
        const memRes = await db.run(
            `INSERT INTO users (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, delegatable_permissions_json)
             VALUES (?, ?, ?, 'MEMBER', 'active', '+998 93 555 66 77', 'Autumn/Winter Cohort Student focusing on Computer Science, Biology & Chemistry.', 1, 1, ?)`,
            [
                'Jasmina Alimova',
                'jasmina.member@learnity.org',
                hashPassword('Member!Pass#2026'),
                JSON.stringify({
                    can_access_subject: true,
                    can_view_materials: true,
                    can_upload_materials: true
                })
            ]
        );
        if (subjBySlug['biology']) {
            await db.run(
                `INSERT OR IGNORE INTO user_subjects
                 (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, assigned_by)
                 VALUES (?, ?, 1, 1, 1, 0, 1, 0, ?)`,
                [memRes.lastInsertRowid, subjBySlug['biology'].id, owner.id]
            );
        }
        if (subjBySlug['chemistry']) {
            await db.run(
                `INSERT OR IGNORE INTO user_subjects
                 (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, assigned_by)
                 VALUES (?, ?, 1, 1, 0, 0, 0, 0, ?)`,
                [memRes.lastInsertRowid, subjBySlug['chemistry'].id, owner.id]
            );
        }
        if (subjBySlug['computer-science']) {
            await db.run(
                `INSERT OR IGNORE INTO user_subjects
                 (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, assigned_by)
                 VALUES (?, ?, 1, 1, 1, 0, 1, 1, ?)`,
                [memRes.lastInsertRowid, subjBySlug['computer-science'].id, owner.id]
            );
        }
    }

    // 5. Seed Media Assets (Preserving Hero Photo + 6 Original Classroom Photos)
    const mediaCount = await db.get("SELECT COUNT(*) AS cnt FROM media_assets");
    if (!mediaCount || mediaCount.cnt === 0) {
        await db.run(
            `INSERT INTO media_assets (card_key, title, caption_date, description, category, image_url, pos_x, pos_y, scale, crop_aspect, display_order, is_hero, is_visible, is_archived, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?)`,
            [
                ORIGINAL_HERO_PHOTO.card_key,
                ORIGINAL_HERO_PHOTO.title,
                ORIGINAL_HERO_PHOTO.caption_date,
                ORIGINAL_HERO_PHOTO.description,
                ORIGINAL_HERO_PHOTO.category,
                ORIGINAL_HERO_PHOTO.image_url,
                ORIGINAL_HERO_PHOTO.pos_x,
                ORIGINAL_HERO_PHOTO.pos_y,
                ORIGINAL_HERO_PHOTO.scale,
                ORIGINAL_HERO_PHOTO.crop_aspect,
                ORIGINAL_HERO_PHOTO.display_order,
                owner.id
            ]
        );

        for (const card of ORIGINAL_LESSON_CARDS) {
            await db.run(
                `INSERT INTO media_assets (card_key, title, caption_date, description, category, image_url, pos_x, pos_y, scale, crop_aspect, display_order, is_hero, is_visible, is_archived, uploaded_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '16:10', ?, 0, 1, 0, ?)`,
                [
                    card.card_key,
                    card.title,
                    card.caption_date,
                    card.description,
                    card.category,
                    card.image_url,
                    card.pos_x,
                    card.pos_y,
                    card.scale,
                    card.display_order,
                    owner.id
                ]
            );
        }
    }

    // 6. Seed Subject Learning Hub Resources
    const resCount = await db.get("SELECT COUNT(*) AS cnt FROM resources");
    if (!resCount || resCount.cnt === 0) {
        const sampleResources = [
            {
                slug: 'computer-science',
                author: 'Javohirbek Mirzayev',
                title: 'Graph Algorithms, Dijkstra & Dynamic Programming Live Clinic',
                description: 'Annotated code repository, complexity proofs, and visual trace walkthroughs.',
                resource_type: 'youtube',
                category: 'Algorithm Clinics',
                external_url: 'https://cp-algorithms.com/',
                duration_or_size: '38 min Clinic + Repo',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'biology',
                author: 'Dr. Aziza Karimova',
                title: 'Cellular Respiration & ATP Synthase Wet-Lab Protocol',
                description: 'Step-by-step spectrophotometry lab guide and mitochondrial electron transport chain problem set.',
                resource_type: 'pdf',
                category: 'Laboratory Protocols',
                external_url: 'https://openstax.org/books/biology-2e/pages/7-introduction',
                duration_or_size: '2.4 MB PDF · 18 Pages',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'biology',
                author: 'Dr. Aziza Karimova',
                title: 'CRISPR-Cas9 Gene Editing Visual Seminar',
                description: 'Recorded walkthrough of guide-RNA design and off-target cleavage analysis.',
                resource_type: 'youtube',
                category: 'Video Lessons',
                external_url: 'https://www.youtube.com/watch?v=2pp17E4E-O8',
                duration_or_size: '24 min Video',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'chemistry',
                author: 'Sardor Rakhimov',
                title: 'Acid-Base Titration Curves & Buffer Equilibrium Deck',
                description: 'Interactive lecture slides covering Henderson-Hasselbalch derivations and equivalence point indicators.',
                resource_type: 'presentation',
                category: 'Lecture Slides',
                external_url: 'https://chem.libretexts.org/',
                duration_or_size: '42 Slides · PPTX/PDF',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'mathematics',
                author: 'Prof. Rustam Yuldashev',
                title: 'Eigenvalues, Diagonalization & Spectral Theorem Clinic',
                description: 'Problem set with geometric visualizations of linear transformations and invariant subspaces.',
                resource_type: 'pdf',
                category: 'Problem Sets',
                external_url: 'https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/',
                duration_or_size: '1.8 MB PDF · 22 Problems',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'economics',
                author: 'Madina Saidova',
                title: 'Macroeconomic Monetary Policy & Market Equilibrium Models',
                description: 'Interactive framework for analyzing central bank interest rates, inflation dynamics, and game theory.',
                resource_type: 'study_guide',
                category: 'Economic Modeling',
                external_url: 'https://www.core-econ.org/',
                duration_or_size: '16-Page Case Study',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'business',
                author: 'Madina Saidova',
                title: 'Unit Economics, Financial Modeling & Venture Strategy Deck',
                description: 'Template and case study workbook covering CAC/LTV, cohort retention, and competitive moats.',
                resource_type: 'presentation',
                category: 'Case Studies',
                external_url: 'https://www.hbs.edu/',
                duration_or_size: '34 Slides',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'global-politics',
                author: 'Dr. Aziza Karimova',
                title: 'International Relations, Sovereignty & Diplomacy Simulation Guide',
                description: 'Briefing dossier on multilateral treaties, comparative political institutions, and policy resolution drafting.',
                resource_type: 'pdf',
                category: 'Policy Seminars',
                external_url: 'https://www.cfr.org/education',
                duration_or_size: '2.1 MB PDF',
                moderation_status: 'Published',
                is_featured: 1
            },
            {
                slug: 'physics',
                author: 'Timur Alimov',
                title: 'RC & RLC Oscillating Circuits Telemetry Lab',
                description: 'Oscilloscope measurement workbook and damping factor calculation templates.',
                resource_type: 'study_guide',
                category: 'Experimental Labs',
                external_url: 'https://phet.colorado.edu/en/simulations/circuit-construction-kit-ac',
                duration_or_size: 'Interactive Sim + Guide',
                moderation_status: 'Published',
                is_featured: 1
            }
        ];

        for (const r of sampleResources) {
            const subj = subjBySlug[r.slug];
            if (!subj) continue;
            await db.run(
                `INSERT INTO resources (subject_id, author_user_id, author_name, title, description, resource_type, category, external_url, duration_or_size, moderation_status, is_featured)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [subj.id, owner.id, r.author, r.title, r.description, r.resource_type, r.category, r.external_url, r.duration_or_size, r.moderation_status, r.is_featured]
            );
        }
    }

    // 7. Seed Announcements
    const annCount = await db.get("SELECT COUNT(*) AS cnt FROM announcements");
    if (!annCount || annCount.cnt === 0) {
        await db.run(
            `INSERT INTO announcements (subject_id, author_user_id, author_name, title, body, priority, audience, is_pinned)
             VALUES (NULL, ?, 'Learnity Academic Council', 'Autumn/Winter Cohort Live Lab Schedule & Demo Day Milestones', 'Welcome to the Learnity interactive ecosystem. Weekly small-group lab sessions begin this Monday. Check your assigned Subject Hubs for pre-lab readings and equipment checklists.', 'important', 'all', 1)`,
            [owner.id]
        );
        if (subjBySlug['biology']) {
            await db.run(
                `INSERT INTO announcements (subject_id, author_user_id, author_name, title, body, priority, audience, is_pinned)
                 VALUES (?, ?, 'Dr. Aziza Karimova', 'Fluorescence Microscopy Lab Preparation', 'Please review the ATP Synthase spectrophotometry protocol PDF before Thursday''s wet-lab session.', 'normal', 'subject', 1)`,
                [subjBySlug['biology'].id, owner.id]
            );
        }
    }

    // 8. Seed Sample Applications
    const appCount = await db.get("SELECT COUNT(*) AS cnt FROM applications");
    if (!appCount || appCount.cnt === 0) {
        const sampleApps = [
            {
                uid: generateApplicationUid(),
                full_name: 'Dilshodabonu Rustamova',
                email: 'dilshoda.r@example.com',
                phone: '+998 90 945 12 34',
                role: 'MEMBER',
                subjects: JSON.stringify(['Biology', 'Chemistry']),
                track: 'Biology & Chemistry',
                schedule: 'Weekday Intensive',
                background: '2nd-year BSc Biotechnology undergraduate at National University of Uzbekistan.',
                motivation: 'I want to transition from passive textbook reading to designing wet-lab experiments and preparing a research paper for Demo Day.',
                status: 'Pending'
            },
            {
                uid: generateApplicationUid(),
                full_name: 'Bekzod Nurmatov',
                email: 'bekzod.dev@example.com',
                phone: '@bekzod_codes',
                role: 'STAFF',
                subjects: JSON.stringify(['Computer Science', 'Mathematics']),
                track: 'Computer Science & Mathematics',
                schedule: 'Weekend Labs',
                background: 'Senior Computer Engineering student & ICPC regional finalist.',
                motivation: 'Excited to mentor small student groups in graph algorithms and code review clinics.',
                status: 'Pending'
            },
            {
                uid: generateApplicationUid(),
                full_name: 'Malika Umarova',
                email: 'malika.u@example.com',
                phone: '+998 93 321 88 99',
                role: 'MEMBER',
                subjects: JSON.stringify(['Economics', 'Business', 'Global Politics']),
                track: 'Economics, Business & Global Politics',
                schedule: 'Weekday Intensive',
                background: 'High school senior preparing for international university fellowships.',
                motivation: 'Looking to sharpen my economic modeling and international policy analysis skills.',
                status: 'Approved'
            }
        ];
        for (const a of sampleApps) {
            await db.run(
                `INSERT INTO applications
                 (application_uid, full_name, email, phone_or_telegram, requested_role, interested_subjects, track, schedule_preference, educational_background, motivation_statement, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [a.uid, a.full_name, a.email, a.phone, a.role, a.subjects, a.track, a.schedule, a.background, a.motivation, a.status]
            );
        }
    }

    // 9. Seed Starter Invitation Code
    const invCount = await db.get("SELECT COUNT(*) AS cnt FROM invitation_codes");
    if (!invCount || invCount.cnt === 0) {
        const demoPlain = 'LRN-STEM-2026-JOIN';
        const demoHash = hashInviteCode(demoPlain);
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        const invRes = await db.run(
            `INSERT INTO invitation_codes (code_hash, code_prefix, target_role, issuer_user_id, issuer_name, label, max_uses, uses_count, expires_at, status)
             VALUES (?, 'LRN-STEM-••••', 'MEMBER', ?, ?, 'Autumn Cohort Starter Invite', 10, 0, ?, 'active')`,
            [demoHash, owner.id, owner.full_name, expiresAt]
        );
        for (const slug of ['computer-science', 'biology', 'chemistry', 'mathematics']) {
            if (subjBySlug[slug]) {
                await db.run(
                    `INSERT INTO invitation_permissions
                     (invitation_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_invite_members, can_generate_codes)
                     VALUES (?, ?, 1, 1, 1, 0, 1, 0, 0, 0)`,
                    [invRes.lastInsertRowid, subjBySlug[slug].id]
                );
            }
        }
    }

    // 10. Seed Email Notification Templates
    for (const [key, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
        const exists = await db.get("SELECT id FROM notifications WHERE channel = 'template' AND template_key = ?", [key]);
        if (!exists) {
            await db.run(
                `INSERT INTO notifications (channel, template_key, subject, body, delivery_status)
                 VALUES ('template', ?, ?, ?, 'template_saved')`,
                [key, tpl.subject, tpl.body]
            );
        }
    }

    // 11. Seed initial audit log
    const logCount = await db.get("SELECT COUNT(*) AS cnt FROM activity_logs");
    if (!logCount || logCount.cnt === 0) {
        await db.run(
            `INSERT INTO activity_logs (actor_user_id, actor_name, actor_role, action_type, target_type, target_id, description, ip_address)
             VALUES (?, ?, 'OWNER', 'SYSTEM_BOOT', 'platform', 'learnity-v3', 'Initialized Learnity database schema, 8 core subjects, persistent media library, and role-based access control.', '127.0.0.1')`,
            [owner.id, owner.full_name]
        );
    }
}

module.exports = {
    seedDatabase,
    ORIGINAL_HERO_PHOTO,
    ORIGINAL_LESSON_CARDS,
    INITIAL_SUBJECTS
};
