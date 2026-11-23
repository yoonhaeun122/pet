const express = require('express');
const session = require('express-session');
require('dotenv').config();

const db = require('./db');
const app = express();

app.set('view engine', 'ejs');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));



// 메인 페이지
app.get('/', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT NOW() AS currentTime');

        let pets = [];
        let stats = {
            healthCount: 0,
            feedingCount: 0,
            latestWeight: null,
            vaccinationCount: 0
        };

        if (req.session.userId) {
            const userId = req.session.userId;

            const [petRows] = await db.query(
                'SELECT * FROM pets WHERE user_id = ?',
                [userId]
            );

            pets = petRows;

            if (pets.length > 0) {
                const [statRows] = await db.query(`
                    SELECT
                    (
                        SELECT COUNT(*)
                        FROM health_records h
                        JOIN pets p ON h.pet_id = p.id
                        WHERE p.user_id = ?
                    ) AS healthCount,

                    (
                        SELECT COUNT(*)
                        FROM feeding_records f
                        JOIN pets p ON f.pet_id = p.id
                        WHERE p.user_id = ?
                        AND DATE(f.fed_at) = CURDATE()
                    ) AS feedingCount,

                    (
                        SELECT w.weight
                        FROM weight_records w
                        JOIN pets p ON w.pet_id = p.id
                        WHERE p.user_id = ?
                        ORDER BY w.measured_at DESC, w.created_at DESC
                        LIMIT 1
                    ) AS latestWeight,

                    (
                        SELECT COUNT(*)
                        FROM health_records h
                        JOIN pets p ON h.pet_id = p.id
                        WHERE p.user_id = ?
                        AND h.category = '예방접종'
                    ) AS vaccinationCount
                `, [userId, userId, userId, userId]);

                stats = statRows[0];
            }
        }

        res.render('index', {
            title: 'PetCare',
            dbTime: rows[0].currentTime,
            pets: pets,
            stats: stats
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('데이터베이스 연결 오류');
    }
});




// 회원가입 페이지
app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

// 회원가입 처리
app.post('/register', async (req, res) => {
    try {
        const { name, username, password, passwordConfirm } = req.body;

        if (!name.trim() || !username.trim() || !password) {
            return res.status(400).render('register', {
                error: '모든 항목을 입력해 주세요.'
            });
        }

        if (password !== passwordConfirm) {
            return res.status(400).render('register', {
                error: '비밀번호가 일치하지 않습니다.'
            });
        }

        if (password.length < 8) {
            return res.status(400).render('register', {
                error: '비밀번호는 8자 이상 입력해 주세요.'
            });
        }

        const bcrypt = require('bcrypt');
        const passwordHash = await bcrypt.hash(password, 10);

        await db.query(
            'INSERT INTO users (username, password_hash, name) VALUES (?, ?, ?)',
            [username.trim(), passwordHash, name.trim()]
        );

        res.send('회원가입 성공! 회원 정보가 저장되었습니다.');

    } catch (error) {
        console.error(error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).render('register', {
                error: '이미 사용 중인 아이디입니다.'
            });
        }

        res.status(500).send('회원가입 중 오류가 발생했습니다.');
    }
});

// 로그인 페이지
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// 로그인 처리
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const [rows] = await db.query(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).render('login', {
                error: '아이디 또는 비밀번호가 틀렸습니다.'
            });
        }

        const bcrypt = require('bcrypt');
        const isMatch = await bcrypt.compare(
            password,
            rows[0].password_hash
        );

        if (!isMatch) {
            return res.status(401).render('login', {
                error: '아이디 또는 비밀번호가 틀렸습니다.'
            });
        }

        req.session.regenerate((err) => {
            if (err) {
                return res.status(500).send('로그인 오류');
            }

            req.session.userId = rows[0].id;
            req.session.username = rows[0].username;
            req.session.name = rows[0].name;

            res.redirect('/');
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('로그인 중 오류가 발생했습니다.');
    }
});

// 로그아웃
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});



// 건강 기록 페이지
app.get('/health/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const [pets] = await db.query(
            'SELECT * FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        const [records] = await db.query(
            'SELECT * FROM health_records WHERE pet_id = ? ORDER BY record_date DESC',
            [req.params.petId]
        );

        res.render('health', {
            pet: pets[0],
            records: records,
            error: null
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('건강 기록 조회 오류');
    }
});

// 건강 기록 등록
app.post('/health/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const { category, title, description, record_date } = req.body;

        const [pets] = await db.query(
            'SELECT id FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        if (!category || !title || !record_date) {
            return res.status(400).send('필수 항목을 입력해 주세요.');
        }

        await db.query(
            `INSERT INTO health_records
            (pet_id, category, title, description, record_date)
            VALUES (?, ?, ?, ?, ?)`,
            [
                req.params.petId,
                category,
                title,
                description || null,
                record_date
            ]
        );

        res.redirect(`/health/${req.params.petId}`);

    } catch (error) {
        console.error(error);
        res.status(500).send('건강 기록 등록 오류');
    }
});


// 급여 기록 페이지
app.get('/feeding/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const [pets] = await db.query(
            'SELECT * FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        const [records] = await db.query(
            'SELECT * FROM feeding_records WHERE pet_id = ? ORDER BY fed_at DESC',
            [req.params.petId]
        );

        res.render('feeding', {
            pet: pets[0],
            records: records
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('급여 기록 조회 오류');
    }
});

// 급여 기록 등록
app.post('/feeding/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const { food_name, amount, unit } = req.body;

        const [pets] = await db.query(
            'SELECT id FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        if (!food_name || !food_name.trim()) {
            return res.status(400).send('사료 이름을 입력해 주세요.');
        }

        if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
            return res.status(400).send('급여량을 올바르게 입력해 주세요.');
        }

        await db.query(
            `INSERT INTO feeding_records
            (pet_id, food_name, amount, unit)
            VALUES (?, ?, ?, ?)`,
            [
                req.params.petId,
                food_name.trim(),
                amount || null,
                unit || 'g'
            ]
        );

        res.redirect(`/feeding/${req.params.petId}`);

    } catch (error) {
        console.error(error);
        res.status(500).send('급여 기록 등록 오류');
    }
});


// 몸무게 기록 페이지
app.get('/weight/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const [pets] = await db.query(
            'SELECT * FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        const [records] = await db.query(
            'SELECT * FROM weight_records WHERE pet_id = ? ORDER BY measured_at DESC',
            [req.params.petId]
        );

        res.render('weight', {
            pet: pets[0],
            records: records
        });

    } catch (error) {
        console.error(error);
        res.status(500).send('몸무게 조회 오류');
    }
});

// 몸무게 기록 등록
app.post('/weight/:petId', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const { weight, measured_at } = req.body;

        const [pets] = await db.query(
            'SELECT id FROM pets WHERE id = ? AND user_id = ?',
            [req.params.petId, req.session.userId]
        );

        if (pets.length === 0) {
            return res.status(404).send('반려동물을 찾을 수 없습니다.');
        }

        if (!weight || !Number.isFinite(Number(weight)) ||
            Number(weight) <= 0 || Number(weight) > 300) {
            return res.status(400).send('몸무게를 올바르게 입력해 주세요.');
        }

        if (!measured_at || !/^\d{4}-\d{2}-\d{2}$/.test(measured_at) ||
            Number.isNaN(Date.parse(measured_at)) ||
            new Date(measured_at).toISOString().slice(0, 10) !== measured_at) {
            return res.status(400).send('측정 날짜를 올바르게 입력해 주세요.');
        }

        await db.query(
            `INSERT INTO weight_records
            (pet_id, weight, measured_at)
            VALUES (?, ?, ?)`,
            [req.params.petId, weight, measured_at]
        );

        res.redirect(`/weight/${req.params.petId}`);

    } catch (error) {
        console.error(error);
        res.status(500).send('몸무게 등록 오류');
    }
});


// 반려동물 등록 페이지
app.get('/pets/register', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    res.render('pet-register', { error: null });
});

// 반려동물 등록 처리
app.post('/pets/register', async (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        const { name, breed, birth_date } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).render('pet-register', {
                error: '반려동물 이름을 입력해 주세요.'
            });
        }

        await db.query(
            `INSERT INTO pets (user_id, name, breed, birth_date)
             VALUES (?, ?, ?, ?)`,
            [
                req.session.userId,
                name.trim(),
                breed ? breed.trim() : null,
                birth_date || null
            ]
        );

        res.send('반려동물 등록 성공!');

    } catch (error) {
        console.error(error);
        res.status(500).send('반려동물 등록 중 오류가 발생했습니다.');
    }
});

app.listen(3000, () => {
    console.log('PetCare 서버 실행!');
    console.log('http://localhost:3000');
});
