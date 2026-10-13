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
