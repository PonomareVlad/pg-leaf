--
-- PostgreSQL database dump
--

SET statement_timeout = 0;

SET client_encoding = 'UTF8';

SET standard_conforming_strings = on;

--
-- Name: cities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."cities" (
    "id" integer NOT NULL,
    "name" "text" NOT NULL
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."users" (
    "id" integer NOT NULL,
    "username" "text" NOT NULL,
    "email" "text" NOT NULL,
    "city_id" integer,
    "balance" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "public"."registrations" (
    "user_id" integer NOT NULL,
    "event" "text" NOT NULL,
    "note" "text"
);

CREATE TABLE "public"."logs" (
    "message" "text"
);

CREATE SEQUENCE "public"."cities_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE "public"."cities_id_seq" OWNED BY "public"."cities"."id";

SELECT pg_catalog.setval('"public"."cities_id_seq"', 2, true);

INSERT INTO "public"."cities" (
  "id",
  "name"
) VALUES (
  2,
  'Tbilisi'
);

INSERT INTO "public"."cities" (
  "id",
  "name"
) VALUES (
  1,
  'Amsterdam'
);

INSERT INTO "public"."logs" (
  "message"
) VALUES (
  'duplicate line'
);

INSERT INTO "public"."logs" (
  "message"
) VALUES (
  'duplicate line'
);

INSERT INTO "public"."registrations" (
  "user_id",
  "event",
  "note"
) VALUES (
  1,
  'launch',
  'VIP'
);

INSERT INTO "public"."registrations" (
  "user_id",
  "event",
  "note"
) VALUES (
  2,
  'launch',
  NULL
);

INSERT INTO "public"."users" (
  "id",
  "username",
  "email",
  "city_id",
  "balance"
) VALUES (
  2,
  'bob',
  'bob@example.com',
  2,
  0
);

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

INSERT INTO "public"."users" (
  "id",
  "username",
  "email",
  "city_id",
  "balance"
) VALUES (
  1,
  'alice',
  'alice@example.com',
  1,
  120
);

--
-- Name: cities cities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."cities"
    ADD CONSTRAINT "cities_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."registrations"
    ADD CONSTRAINT "registrations_user_event_key" UNIQUE ("user_id", "event");

--
-- Name: users_city_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "users_city_id_idx" ON "public"."users" USING "btree" ("city_id");

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id");

--
-- PostgreSQL database dump complete
--
