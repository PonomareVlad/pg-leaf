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
