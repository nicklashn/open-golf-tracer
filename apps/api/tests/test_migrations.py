"""The migration chain on a database with data in it, the backup taken before migrating, and an
older app meeting a newer database."""
import json
import sqlite3

import pytest


def _db_file(env):
    return env / "data" / "open-golf-tracer.db"


def _insert(con, table, **values):
    """A row with every NOT NULL column filled (by type), overridden by `values`."""
    cols = con.execute(f"PRAGMA table_info({table})").fetchall()
    row = {}
    for _, name, typ, notnull, _default, _pk in cols:
        if notnull or name in values:
            t = (typ or "").upper()
            row[name] = values.get(name, 0 if ("INT" in t or "BOOL" in t or "FLOAT" in t or "REAL" in t) else
                                   "2026-01-01 00:00:00" if "DATETIME" in t else "{}" if "JSON" in t else "x")
    con.execute(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", list(row.values()))


def _upgrade_to(rev):
    from alembic import command

    from golf_api.main import _alembic_config

    command.upgrade(_alembic_config(), rev)


def test_full_chain_on_a_populated_database_backs_it_up_first(env):
    from golf_api import db, main

    _upgrade_to("0001")
    db.reset_engine()
    con = sqlite3.connect(_db_file(env))
    _insert(con, "users", id="usr_1", locale="da", units="m")
    _insert(con, "projects", id="prj_1", user_id="usr_1", name="Runde", document=json.dumps({"clips": [1]}),
            analysis=json.dumps({"med_1": {"shots": []}}))
    _insert(con, "media", id="med_1", user_id="usr_1", project_id="prj_1", kind="video", filename="a.mp4", storage_key="k")
    _insert(con, "jobs", id="job_1", kind="analyze", status="queued", user_id="usr_1", project_id="prj_1")
    _insert(con, "exports", id="exp_1", user_id="usr_1", project_id="prj_1", status="succeeded")
    con.commit()
    con.close()

    main.migrate()

    con = sqlite3.connect(_db_file(env))
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(main._alembic_config()).get_current_head()
    assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == head
    assert con.execute("SELECT name, analysis FROM projects").fetchone() == ("Runde", json.dumps({"med_1": {"shots": []}}))
    assert con.execute("SELECT id, interruptions, lease FROM jobs").fetchone() == ("job_1", 0, None)
    assert con.execute("SELECT count(*) FROM media").fetchone()[0] == 1
    assert con.execute("SELECT count(*) FROM exports").fetchone()[0] == 1
    # The users row survived the batch copies (foreign keys are off while migrating).
    assert con.execute("SELECT count(*) FROM users").fetchone()[0] == 1
    con.close()

    (backup,) = (env / "data" / "backups").glob("db-0001-*.sqlite")
    b = sqlite3.connect(backup)
    assert b.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0001"
    assert b.execute("SELECT count(*) FROM projects").fetchone()[0] == 1
    b.close()

    # Already at head: no new backup.
    main.migrate()
    assert len(list((env / "data" / "backups").glob("*.sqlite"))) == 1

    # The ORM works on the migrated data.
    from golf_api.db import session_scope
    from golf_api.models import Job

    db.reset_engine()
    with session_scope() as s:
        assert s.get(Job, "job_1").interruptions == 0


def test_backups_keep_the_last_five(env):
    from golf_api import main

    _upgrade_to("head")
    for _ in range(7):
        main._backup_sqlite("0004")
    assert len(list((env / "data" / "backups").glob("db-*.sqlite"))) == main.KEEP_BACKUPS


def test_downgrade_chain_runs(env):
    from alembic import command

    from golf_api.main import _alembic_config

    _upgrade_to("head")
    con = sqlite3.connect(_db_file(env))
    _insert(con, "users", id="usr_1")
    _insert(con, "jobs", id="job_1", kind="ingest", status="queued", user_id="usr_1", lease="abc", interruptions=2)
    con.commit()
    con.close()
    command.downgrade(_alembic_config(), "0001")
    con = sqlite3.connect(_db_file(env))
    assert con.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    con.close()


def test_an_older_app_on_newer_data_says_so(env):
    from golf_api import db, main

    _upgrade_to("head")
    con = sqlite3.connect(_db_file(env))
    con.execute("UPDATE alembic_version SET version_num = '0099'")
    con.commit()
    con.close()
    db.reset_engine()
    with pytest.raises(main.NewerDataError) as err:
        main.migrate()
    msg = str(err.value)
    assert msg.startswith(main.NEWER_DATA) and "newer version" in msg and "Install the newest version" in msg
    # Nothing was touched, and no backup of a database we don't understand.
    con = sqlite3.connect(_db_file(env))
    assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0099"
    assert not (env / "data" / "backups").exists() or not list((env / "data" / "backups").iterdir())
