const bcrypt = require('bcryptjs');
const { supabase } = require('../models/supabaseClient');
const { signToken } = require('../middleware/auth');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    favorite_categories_breakdown: user.favorite_categories_breakdown || null,
  };
}

async function register(req, res) {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'weak_password', detail: 'Password must be at least 8 characters.' });
    }

    const { data: existing, error: existingError } = await supabase
      .from('Users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingError && existingError.code && existingError.code !== 'PGRST116') {
      throw existingError;
    }
    if (existing && existing.id) {
      return res.status(409).json({ error: 'email_taken' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const { data: inserted, error: insertError } = await supabase
      .from('Users')
      .insert([{ email: normalizedEmail, password_hashed: passwordHash, favorite_categories_breakdown: {} }])
      .select('id,email,favorite_categories_breakdown')
      .single();

    if (insertError) throw insertError;

    const token = signToken({ sub: inserted.id, email: inserted.email });
    return res.status(201).json({ token, user: publicUser(inserted) });
  } catch (err) {
    console.error('[auth.register] error', err);
    return res.status(500).json({ error: 'register_failed', detail: err?.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({ error: 'invalid_credentials' });
    }
    if (!password) {
      return res.status(400).json({ error: 'invalid_credentials' });
    }

    const { data: user, error } = await supabase
      .from('Users')
      .select('id,email,password_hashed,favorite_categories_breakdown')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (error && error.code && error.code !== 'PGRST116') {
      throw error;
    }
    if (!user || !user.password_hashed) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const isMatch = await bcrypt.compare(String(password), user.password_hashed);
    if (!isMatch) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = signToken({ sub: user.id, email: user.email });
    delete user.password_hashed;
    return res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth.login] error', err);
    return res.status(500).json({ error: 'login_failed', detail: err?.message });
  }
}

async function me(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'auth_required' });

    const { data, error } = await supabase
      .from('Users')
      .select('id,email,favorite_categories_breakdown')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'user_not_found' });

    return res.json({ user: publicUser(data) });
  } catch (err) {
    console.error('[auth.me] error', err);
    return res.status(500).json({ error: 'profile_failed', detail: err?.message });
  }
}

module.exports = {
  register,
  login,
  me,
};
