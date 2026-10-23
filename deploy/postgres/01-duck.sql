\getenv duck_password DUCK_DB_PASSWORD
CREATE ROLE duck LOGIN PASSWORD :'duck_password';
ALTER DATABASE duck OWNER TO duck;
