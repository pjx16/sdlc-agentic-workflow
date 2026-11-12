FROM ubuntu/squid:latest
COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/sdlc-proxy-entrypoint.sh
RUN chmod +x /usr/local/bin/sdlc-proxy-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/sdlc-proxy-entrypoint.sh"]
CMD ["-f", "/etc/squid/squid.conf", "-NYC"]
