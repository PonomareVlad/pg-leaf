INSERT INTO "public"."users" (
  "id",
  "username",
  "email",
  "city_id",
  "balance"
) VALUES (
  3,
  'carol; -- ''quoted''',
  E'carol+\n@example.com',
  NULL,
  -5
);
