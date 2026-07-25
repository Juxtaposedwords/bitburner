# Protos

Rather than fuss with ports, let's generate all the client/server interactions with port. This will let us automate the client/server generation, streamline clinet interaction, and hopefully make the code simpler/boring.


Intresting notes:
1. In BitBurner Netscript ports are universal, so communication must be unique:
   * **Requirement**: Generation must be aware of the current protos 
BitBurner's NetScript ports are universal. They do not require an address