import english from './character-core.en.json' with {type:'json'}

export function englishCharacterGroups(groups){
  return groups.map(group=>{
    const copy=english[group.module.split('.')[1]]
    if(!copy)return group
    return {...group,label:copy.label,facets:group.facets.map(facet=>{
      const translated=copy.facets[facet.id]
      return translated?{...facet,label:translated[0],vocabulary:translated[1]}:facet
    })}
  })
}
