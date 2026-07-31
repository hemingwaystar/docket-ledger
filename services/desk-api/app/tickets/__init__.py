"""Ticket surface, one router per concern. Reads mirror window.DocketAPI;
writes cover the working loop: props (optimistic-locked), tags, pending
wakes, time, links (0025) and transactional merge (HANDOFF §10.11).
Locked projects refuse everything (423). main.py mounts `routers`."""
from . import articles, bootstrap, links, merge, read, time, write

routers = [read.router, bootstrap.router, write.router, time.router,
           merge.router, links.router, articles.router]
