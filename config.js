// Fill in from Supabase > Project Settings > API: the project URL and the anon / publishable key.
// Both are meant to be public: the database rules (supabase/schema.sql) decide what a signed-in grader may see or change.
// NEVER put the service_role / secret key here.
// Leave supabaseUrl empty to run the page in demo mode (local sample images, votes kept in this browser only).
window.GRADING_CONFIG = {
  supabaseUrl: "https://vxvrliydyhxobrlzveca.supabase.co",
  supabaseKey: "sb_publishable_PTo7oswGyBzGMi6Ks53h_A_H6gKNPUP",
};
